// desempenho.js
// Desempenho por PRODUTO (não por plataforma). Enquanto comissoes-afiliados.json
// responde "quanto a Shopee rendeu ontem", este arquivo responde "qual produto
// puxou clique e qual converteu" — que é o que decide o que vale redivulgar.
//
// A ponte entre o relatório da plataforma e o produto é o ledger rastreio.json,
// escrito pelo baileys-server no momento do disparo: ele guarda ref -> produto.
// Sem o ledger o relatório é ilegível, porque a marcação sozinha não diz nada.
//
// Shopee é a primeira loja porque o sub_id1 é texto livre e determinístico por
// item: não depende de pool, de teto de identificadores nem de cadastro manual.
//
// Este módulo NUNCA pode derrubar a coleta principal. Toda a chamada em
// coletar-comissoes.js fica em try/catch e uma falha aqui só registra aviso.

const crypto = require('crypto');

const REPO_DADOS = process.env.REPO_DADOS || 'davileles/cdv-tsp-dados';
const ARQ_DESEMPENHO = process.env.ARQUIVO_DESEMPENHO || 'tsp/desempenho-produtos.json';
const ARQ_RASTREIO = process.env.ARQUIVO_RASTREIO || 'tsp/rastreio.json';
const ARQ_DESCOBERTAS = process.env.ARQUIVO_DESCOBERTAS || 'tsp/vendas-descobertas.json';
const GH_TOKEN = process.env.GH_TOKEN_DADOS;

const SHOPEE_COOKIE = process.env.SHOPEE_COOKIE;
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;

const AMAZON_COOKIE = process.env.AMAZON_COOKIE;

const ML_COOKIE = process.env.ML_COOKIE;

const AWIN_TOKEN = process.env.AWIN_TOKEN;
const AWIN_PUBLISHER_ID = process.env.AWIN_PUBLISHER_ID;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

async function req(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

const num = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;

// ── GitHub ────────────────────────────────────────────────────────────────

async function lerJson(caminho, padrao = null) {
  const r = await req(`https://api.github.com/repos/${REPO_DADOS}/contents/${caminho}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return { sha: null, dados: padrao };
  if (!r.ok) throw new Error(`leitura de ${caminho}: status ${r.status}`);
  const j = await r.json();
  // Acima de ~1MB a Contents API devolve encoding 'none' e content vazio; o
  // blob endpoint continua entregando o conteúdo inteiro.
  if (j.encoding !== 'base64' || !j.content) {
    const b = await req(`https://api.github.com/repos/${REPO_DADOS}/git/blobs/${j.sha}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (!b.ok) throw new Error(`blob de ${caminho}: status ${b.status}`);
    const jb = await b.json();
    return { sha: j.sha, dados: JSON.parse(Buffer.from(jb.content, 'base64').toString('utf8')) };
  }
  return { sha: j.sha, dados: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}

async function gravarJson(caminho, dados, mensagem) {
  // 503/502 do GitHub e 409 por SHA velho sao transitorios: o SHA e relido a
  // cada tentativa (o baileys escreve no mesmo repo), entao repetir resolve os
  // dois casos. Sem retry, uma indisponibilidade de segundos custava a rodada.
  let ultimo = '';
  for (let tent = 0; tent < 3; tent++) {
    const atual = await lerJson(caminho, null);
    const corpo = {
      message: mensagem,
      content: Buffer.from(JSON.stringify(dados, null, 1), 'utf8').toString('base64'),
    };
    if (atual.sha) corpo.sha = atual.sha;
    const r = await req(`https://api.github.com/repos/${REPO_DADOS}/contents/${caminho}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    }, 60000);
    if (r.ok) return;
    ultimo = `status ${r.status} — ${(await r.text()).slice(0, 200)}`;
    if (![409, 500, 502, 503].includes(r.status)) break;
    await new Promise((res) => setTimeout(res, 2000 * (tent + 1)));
  }
  throw new Error(`gravação de ${caminho}: ${ultimo}`);
}

// ── Shopee ────────────────────────────────────────────────────────────────

async function shopeeGql(query) {
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('sha256').update(SHOPEE_APP_ID + ts + payload + SHOPEE_SECRET).digest('hex');
  const r = await req('https://open-api.affiliate.shopee.com.br/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${SHOPEE_APP_ID}, Timestamp=${ts}, Signature=${sign}`,
    },
    body: payload,
  });
  const j = await r.json();
  if (j.errors) throw new Error(`Open API: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.data;
}

// O nome do campo que carrega o sub_id muda entre versões da API da Shopee
// (utmContent, subIds, attributionSubIds já apareceram em documentações
// diferentes). Em GraphQL, pedir um campo inexistente derruba a query inteira —
// então descobrimos o nome por introspecção antes de montar a consulta, em vez
// de chutar e quebrar a coleta.
let _campoSubId = null;

async function descobrirCampoSubId() {
  if (_campoSubId !== null) return _campoSubId;
  const d = await shopeeGql('{ __schema { queryType { fields { name type { name ofType { name } } } } } }');
  const campos = d?.__schema?.queryType?.fields || [];
  const conv = campos.find((f) => f.name === 'conversionReport');
  const tipo = conv?.type?.name || conv?.type?.ofType?.name;
  if (!tipo) { _campoSubId = ''; return ''; }

  // nodes é uma lista; o tipo do item é quem tem os campos que interessam.
  const dt = await shopeeGql(`{ __type(name:"${tipo}"){ fields { name type { name ofType { name } } } } }`);
  const fNodes = (dt?.__type?.fields || []).find((f) => f.name === 'nodes');
  const tipoNode = fNodes?.type?.ofType?.name || fNodes?.type?.name;
  if (!tipoNode) { _campoSubId = ''; return ''; }

  const dn = await shopeeGql(`{ __type(name:"${tipoNode}"){ fields { name } } }`);
  const nomes = (dn?.__type?.fields || []).map((f) => f.name);
  console.log('[desempenho] campos de ' + tipoNode + ': ' + nomes.join(', '));
  _campoSubId = nomes.find((n) => /^utmContent$/i.test(n))
    || nomes.find((n) => /sub_?ids?$/i.test(n))
    || '';
  console.log('[desempenho] campo de sub_id na Shopee: ' + (_campoSubId || '(nenhum encontrado)'));
  return _campoSubId;
}

async function shopeeConversaoPorSubId(inicio, fim) {
  const campo = await descobrirCampoSubId();
  if (!campo) return {};

  const out = {};
  let scrollId = null, guard = 0;
  do {
    const sc = scrollId ? `, scrollId:"${scrollId}"` : '';
    const d = await shopeeGql(`{ conversionReport(purchaseTimeStart:${inicio}, `
      + `purchaseTimeEnd:${fim}, limit:500${sc}){ `
      + `nodes { ${campo} totalCommission orders { items { actualAmount } } } `
      + 'pageInfo { hasNextPage scrollId } } }');

    const rep = d?.conversionReport;
    if (!rep) break;
    for (const n of rep.nodes || []) {
      const bruto = n[campo];
      const ref = Array.isArray(bruto) ? String(bruto[0] || '') : String(bruto || '');
      if (!ref) continue;
      const reg = out[ref] || (out[ref] = { pedidos: 0, vendas: 0, comissao: 0 });
      reg.pedidos += 1;
      reg.comissao = num(reg.comissao + parseFloat(n.totalCommission || 0));
      for (const o of n.orders || []) {
        for (const it of o.items || []) reg.vendas = num(reg.vendas + parseFloat(it.actualAmount || 0));
      }
    }
    scrollId = rep.pageInfo?.hasNextPage ? rep.pageInfo.scrollId : null;
  } while (scrollId && ++guard < 30);

  return out;
}

// Cliques vêm do painel (cookie), não da Open API. As linhas trazem o sub_id em
// alguma chave cujo nome também varia — aqui dá para inspecionar o objeto e
// escolher a chave certa em tempo de execução, sem risco de derrubar a query.
async function shopeeCliquesPorSubId(inicio, fim) {
  const out = {};
  let pagina = 1, chave = null;
  for (; pagina <= 50; pagina++) {
    const url = 'https://affiliate.shopee.com.br/api/v1/click_report/list'
      + `?click_time_s=${inicio}&click_time_e=${fim}&page_num=${pagina}&page_size=100`;
    const r = await req(url, {
      headers: {
        'user-agent': UA, accept: '*/*',
        referer: 'https://affiliate.shopee.com.br/report/click_report',
        cookie: SHOPEE_COOKIE,
      },
    });
    if (!r.ok) throw new Error(`cliques: status ${r.status}`);
    const j = await r.json();
    if (j.code !== 0) throw new Error(`cliques: code ${j.code} — renove SHOPEE_COOKIE`);

    const linhas = j.data?.list || j.data?.rows || [];
    if (!linhas.length) break;

    if (chave === null) {
      const chaves = Object.keys(linhas[0] || {});
      console.log('[desempenho] colunas do relatório de cliques: ' + chaves.join(', '));
      chave = chaves.find((k) => /sub_?id_?1$/i.test(k))
        || chaves.find((k) => /sub_?id/i.test(k))
        || chaves.find((k) => /utm_?content/i.test(k))
        || '';
      console.log('[desempenho] coluna de sub_id nos cliques: ' + (chave || '(nenhuma encontrada)'));
      if (!chave) return {};
    }

    for (const l of linhas) {
      const ref = String(l[chave] || '');
      if (!ref) continue;
      out[ref] = (out[ref] || 0) + 1;
    }
    if (linhas.length < 100) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  return out;
}

// ── Amazon por tracking ID ────────────────────────────────────────────────
//
// O filtro por tracking ID não é um query param da página: é a API interna
// /reporting/table, autenticada por headers. Tudo que ela exige vem embutido
// no HTML de /p/reporting/earnings, que já baixamos com o AMAZON_COOKIE:
//   - <meta name="csrf-token">            -> header X-CSRF-Token
//   - #pageState[data-page-state] (JSON)  -> associateIdentityToken (Bearer)
//                                            + contexto (marketplaceId etc.)
// Receita levantada por engenharia reversa do bundle AssociateReportsAssets
// (função getAuthToken + wrapper ajax de ac-utils) em 17/08/2026.
//
// Com group_by=tag_id e start=end=D, UMA chamada devolve todas as tags com
// atividade no dia D — cliques, pedidos, receita e ganhos — já com o
// tag_value em cada linha (o tag_id numérico é dispensável).

async function amazonContexto() {
  const r = await req('https://associados.amazon.com.br/p/reporting/earnings', {
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9', cookie: AMAZON_COOKIE },
    redirect: 'manual',
  });
  if (r.status >= 300 && r.status < 400) throw new Error('sessão expirada (302) — renove AMAZON_COOKIE');
  if (!r.ok) throw new Error(`página de relatórios: status ${r.status}`);
  const html = await r.text();

  // A API valida o Bearer junto com a sessão: a resposta da página emite
  // cookies (session-id etc.) via Set-Cookie que o AMAZON_COOKIE não traz.
  // Sem eles a /reporting/table devolve 401 mesmo com token válido.
  const emitidos = (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [])
    .map((sc) => sc.split(';')[0].trim())
    .filter((sc) => sc && !/^(deleted|=)/.test(sc));
  const cookie = [AMAZON_COOKIE, ...emitidos].filter(Boolean).join('; ');

  // O pageState aparece no HTML ora como JSON puro em atributo de aspas
  // simples, ora como JSON escapado dentro de string, ora com entidades HTML
  // — o formato varia conforme cookie/UA da requisição. A extração campo a
  // campo abaixo tolera os três; validada contra o HTML cru em 17/08/2026.
  const Q = '(?:\\\\"|"|&quot;)';
  const campo = (nome) => {
    const m = html.match(new RegExp(nome + Q + '\\s*:\\s*' + Q + '([^"\\\\&]+)'));
    return m ? m[1] : null;
  };
  const camposArr = (nome) => {
    const m = html.match(new RegExp(nome + Q + '\\s*:\\s*\\[([^\\]]*)\\]'));
    if (!m) return [];
    return [...m[1].matchAll(new RegExp(Q + '([^"\\\\&,\\]]+)' + Q, 'g'))].map((x) => x[1]);
  };

  const token = campo('associateIdentityToken');
  if (!token) throw new Error('associateIdentityToken não encontrado — layout da página mudou');
  const storeId = campo('storeId');
  if (!storeId) throw new Error('storeId não encontrado no pageState');

  return {
    storeId,
    headers: {
      'user-agent': UA, cookie, accept: 'application/json',
      authorization: 'Bearer ' + token,
      marketplaceid: campo('marketplaceId') || '', locale: campo('locale') || 'BR',
      storeid: storeId, customerid: campo('customerId') || '',
      programid: campo('programId') || '',
      roles: camposArr('roles').join(','),
      language: campo('language') || 'pt_BR', 'x-requested-with': 'XMLHttpRequest',
      // Sem referer/origin a API devolve 401 mesmo com token e sessão válidos
      // (comprovado no runner em 17/08/2026 — variantes A/B 401, C 200).
      referer: 'https://associados.amazon.com.br/p/reporting/earnings',
      origin: 'https://associados.amazon.com.br',
      'accept-language': 'pt-BR,pt;q=0.9',
    },
  };
}

// A API devolve números como string, com "-" para vazio e vírgula de milhar
// possível em valores grandes. Este parser cobre os três casos.
const numApi = (v) => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : 0;
};

/** Linhas (uma por tag com atividade) do dia `data` (YYYY-MM-DD). */
async function amazonTagsDoDia(ctx, data) {
  const qs = new URLSearchParams({
    'query[type]': 'overview',
    'query[start_date]': data, 'query[end_date]': data,
    'query[group_by]': 'tag_id',
    'query[columns]': 'tag_value,tag_id,clicks,total_ordered_items,shipped_revenue,total_earnings',
    'query[order]': 'desc', 'query[sort]': 'clicks',
    'query[skip]': '0', 'query[limit]': '200', 'query[next_token]': '',
    'query[storeId]': ctx.storeId, 'query[locale]': 'BR',
    store_id: ctx.storeId,
  });
  let r;
  for (let tent = 0; ; tent++) {
    r = await req('https://associados.amazon.com.br/reporting/table?' + qs.toString(), {
      headers: ctx.headers,
    });
    // 429 esporádico ao varrer a janela de 15 dias: uma pausa resolve.
    if (r.status !== 429 || tent >= 2) break;
    await new Promise((res) => setTimeout(res, 2500 * (tent + 1)));
  }
  if (r.status === 401) throw new Error('API recusou o token (401) — renove AMAZON_COOKIE');
  if (!r.ok) throw new Error(`reporting/table: status ${r.status}`);
  const j = await r.json();
  return j.records || [];
}

// Na Amazon o pool de refs rotaciona: o mesmo tracking ID aponta para produtos
// diferentes em dias diferentes. A atribuição válida para o dia D é a mais
// recente com data <= D — diferente da Shopee, onde o ref é determinístico.
function resolutorAmazon(atribuicoes) {
  const porRef = new Map();
  for (const a of atribuicoes) {
    if (!a.ref || String(a.loja || '').toLowerCase() !== 'amazon') continue;
    if (!porRef.has(a.ref)) porRef.set(a.ref, []);
    porRef.get(a.ref).push(a);
  }
  for (const lista of porRef.values()) lista.sort((x, y) => String(x.ts || x.data || '').localeCompare(String(y.ts || y.data || '')));
  return {
    refs: [...porRef.keys()],
    resolver(ref, dia) {
      const lista = porRef.get(ref) || [];
      let achado = null;
      for (const a of lista) { if ((a.data || '') <= dia) achado = a; else break; }
      return achado;
    },
  };
}

/**
 * Itens pedidos por ASIN — inclui o que o publico comprou sem ser divulgado
 * por nos. Mesma API do desempenho por tag, trocando o group_by; uma chamada
 * pela janela inteira, porque aqui interessa o produto e nao o dia da tag.
 */
async function amazonItensPedidos(ctx, de, ate) {
  const qs = new URLSearchParams({
    'query[type]': 'earning',
    'query[start_date]': de, 'query[end_date]': ate,
    'query[group_by]': 'asin',
    'query[columns]': 'asin,title,category,items_shipped,price,earnings',
    'query[order]': 'desc', 'query[sort]': 'earnings',
    'query[skip]': '0', 'query[limit]': '200', 'query[next_token]': '',
    'query[storeId]': ctx.storeId, 'query[locale]': 'BR',
    store_id: ctx.storeId,
  });
  const r = await req('https://associados.amazon.com.br/reporting/table?' + qs.toString(),
    { headers: ctx.headers });
  if (!r.ok) throw new Error(`itens pedidos: status ${r.status}`);
  const j = await r.json();
  return j.records || [];
}

async function desempenhoAmazon(janela, atribuicoes, registrar, coletarNaoAtribuida) {
  if (!AMAZON_COOKIE) {
    console.log('[desempenho] AMAZON_COOKIE ausente — Amazon por tag ignorada');
    return 0;
  }
  const { refs, resolver } = resolutorAmazon(atribuicoes);
  if (!refs.length) { console.log('[desempenho] ledger sem refs da Amazon'); return 0; }
  const doPool = new Set(refs);

  const ctx = await amazonContexto();

  let mudou = 0;
  for (const dia of janela) {
    let linhas;
    try { linhas = await amazonTagsDoDia(ctx, dia); }
    catch (e) { console.warn(`[desempenho] Amazon ${dia}: ${e.message}`); continue; }

    for (const l of linhas) {
      const ref = String(l.tag_value || '');
      // Fora do pool = tag padrão da conta ou tráfego de outro canal: não é
      // atribuível a produto e ficaria errado no ranking.
      if (!doPool.has(ref)) continue;
      const registro = {
        cliques: Math.round(numApi(l.clicks)),
        pedidos: Math.round(numApi(l.total_ordered_items)),
        vendas: num(numApi(l.shipped_revenue)),
        comissao: num(numApi(l.total_earnings)),
      };
      if (!registro.cliques && !registro.pedidos && !registro.vendas && !registro.comissao) continue;
      const attr = resolver(ref, dia);
      if (!attr) continue; // tráfego anterior à primeira atribuição desse ref
      mudou += registrar(dia, attr, registro);
    }
    await new Promise((res) => setTimeout(res, 400));
  }

  // Produtos comprados na janela que nao estao no ledger: leitura de mercado,
  // nao desempenho de disparo (a Amazon nao diz por qual link vieram).
  if (coletarNaoAtribuida) {
    try {
      const dias = [...janela].sort();
      const doLedger = new Set(atribuicoes
        .filter((a) => /amazon/i.test(String(a.loja || '')))
        .map((a) => String(a.asin || '').toUpperCase()));
      for (const it of await amazonItensPedidos(ctx, dias[0], dias[dias.length - 1])) {
        const asin = String(it.asin || '').toUpperCase();
        const unidades = Math.round(numApi(it.items_shipped));
        if (!asin || doLedger.has(asin) || !unidades) continue;
        coletarNaoAtribuida({
          loja: 'Amazon', id: asin, dia: null, tipo: 'nao_divulgado',
          nome: it.title || '', categoria: it.category || '', vendedor: '',
          link: 'https://www.amazon.com.br/dp/' + asin,
          unidades, vendas: numApi(it.price), comissao: numApi(it.earnings),
        });
      }
    } catch (e) {
      console.warn('[desempenho] Amazon: itens pedidos falhou —', e.message);
    }
  }
  return mudou;
}

// ── Mercado Livre por produto ─────────────────────────────────────────────
//
// O relatorio /dashboard/sales/general lista VENDAS, uma por linha, com o link
// do produto comprado. Nao existe campo de link/tag de origem, entao so as
// vendas DIRECT (item comprado == item divulgado) sao atribuiveis; as INDIRECT
// vem de quem clicou no nosso link e comprou outra coisa, e somar essas ao
// produto divulgado seria inventar atribuicao. Cliques por produto o painel
// nao expoe em nenhuma aba — o ML fica com conversao e comissao, sem clique.
//
// O ledger guarda o id no formato MLB{n}; os links vem como
// /MLB-{n}-slug (item) ou /up/MLBU{n} (catalogo unificado, id diferente).

const idMlDoLink = (url) => {
  const s = String(url || '');
  const mu = s.match(/\/up\/(MLBU\d{6,})/i);
  if (mu) return mu[1].toUpperCase();
  const m = s.match(/\bMLB-?(\d{6,})/i);
  return m ? 'MLB' + m[1] : null;
};

async function desempenhoMl(janela, atribuicoes, registrar, coletarNaoAtribuida) {
  if (!ML_COOKIE) {
    console.log('[desempenho] ML_COOKIE ausente — Mercado Livre ignorado');
    return 0;
  }
  const porId = new Map();
  for (const a of atribuicoes) {
    if (!/mercado\s*livre/i.test(String(a.loja || ''))) continue;
    const id = String(a.asin || '').toUpperCase();
    if (!id) continue;
    const ant = porId.get(id);
    if (!ant || (a.data || '') > (ant.data || '')) porId.set(id, a);
  }
  if (!porId.size) { console.log('[desempenho] ledger sem refs do Mercado Livre'); return 0; }

  const dias = [...janela].sort();
  const range = `${dias[0]}T00:00:00.000-03:00--${dias[dias.length - 1]}T23:59:59.999-03:00`;
  const UA_ML = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  const linhas = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
    const qs = new URLSearchParams({
      filter_time_range: range, items_per_page: '50', order_by: 'ord_date_created',
      page: String(pagina), sort: 'desc', type: 'GENERAL',
    });
    const r = await req('https://www.mercadolivre.com.br/affiliate-program/api/dashboard/sales/general?' + qs,
      { headers: { 'user-agent': UA_ML, accept: 'application/json', cookie: ML_COOKIE } });
    if (r.status === 401 || r.status === 403) throw new Error('sessão expirada — renove ML_COOKIE');
    if (!r.ok) throw new Error(`sales/general: status ${r.status}`);
    const j = await r.json();
    const lote = j.item_list || [];
    linhas.push(...lote);
    if (lote.length < 50 || linhas.length >= (j.total_results || 0)) break;
    await new Promise((res) => setTimeout(res, 400));
  }

  // Agrega por (id, dia) somando apenas vendas diretas.
  const agreg = new Map();
  let indiretas = 0, semCasar = 0;
  for (const x of linhas) {
    const m = String(x.date || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const dia = m ? `${m[3]}-${m[2]}-${m[1]}` : String(x.date || '').slice(0, 10);
    const direta = String(x.saleType || '').toUpperCase() === 'DIRECT';
    const id = idMlDoLink(x.link);
    const noLedger = id && porId.has(id);

    // Toda venda que nao vira desempenho de um produto NOSSO ainda diz o que o
    // publico comprou — vai para o arquivo de nao atribuidas em vez de sumir.
    if (!direta || !noLedger) {
      if (!direta) indiretas++; else semCasar++;
      coletarNaoAtribuida?.({
        loja: 'Mercado Livre',
        id, dia, tipo: direta ? 'direta_fora_do_ledger' : 'indireta',
        nome: x.productName || '', categoria: x.categoryName || '',
        vendedor: x.storeName || '', link: x.link || '',
        unidades: Math.max(1, parseInt(x.saleUnits, 10) || 1),
        vendas: parseFloat(x.saleValue) || 0,
        comissao: parseFloat(x.commissionValue) || 0,
      });
      continue;
    }
    if (!janela.includes(dia)) continue;
    const chave = id + '|' + dia;
    const g = agreg.get(chave) || { id, dia, pedidos: 0, vendas: 0, comissao: 0 };
    g.pedidos += Math.max(1, parseInt(x.saleUnits, 10) || 1);
    g.vendas = num(g.vendas + (parseFloat(x.saleValue) || 0));
    g.comissao = num(g.comissao + (parseFloat(x.commissionValue) || 0));
    agreg.set(chave, g);
  }
  if (indiretas || semCasar) {
    console.log(`[desempenho] ML: ${indiretas} vendas indiretas (nao atribuiveis), ${semCasar} diretas sem produto no ledger`);
  }

  let mudou = 0;
  for (const g of agreg.values()) {
    mudou += registrar(g.dia, porId.get(g.id), {
      cliques: 0, pedidos: g.pedidos, vendas: g.vendas, comissao: g.comissao,
    });
  }
  return mudou;
}

// ── Awin por clickref ─────────────────────────────────────────────────────
//
// A Awin nao expoe cliques por ref, mas o relatorio de transacoes devolve os
// clickRefs de cada venda — conversao e comissao por produto, sem clique.
// Refs da Awin comecam sempre com 'awin' (derivados de 'AWIN-{id}-{hash}'),
// o que isola o casamento e impede colisao com refs de outras lojas.

async function desempenhoAwin(janela, atribuicoes, registrar) {
  if (!AWIN_TOKEN || !AWIN_PUBLISHER_ID) {
    console.log('[desempenho] AWIN_TOKEN/AWIN_PUBLISHER_ID ausentes — Awin ignorada');
    return 0;
  }
  const porRef = new Map();
  for (const a of atribuicoes) {
    if (!a.ref || !String(a.ref).startsWith('awin')) continue;
    const ant = porRef.get(a.ref);
    if (!ant || (a.data || '') > (ant.data || '')) porRef.set(a.ref, a);
  }
  if (!porRef.size) { console.log('[desempenho] ledger sem refs da Awin'); return 0; }

  const dias = [...janela].sort();
  const url = `https://api.awin.com/publishers/${AWIN_PUBLISHER_ID}/transactions/`
    + `?startDate=${encodeURIComponent(dias[0] + 'T00:00:00')}`
    + `&endDate=${encodeURIComponent(dias[dias.length - 1] + 'T23:59:59')}`
    + `&timezone=America/Sao_Paulo`;
  const r = await req(url, { headers: { Authorization: 'Bearer ' + AWIN_TOKEN, accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw new Error('AWIN_TOKEN recusado (' + r.status + ')');
  if (!r.ok) throw new Error(`transacoes Awin: status ${r.status}`);
  const trans = await r.json();
  if (!Array.isArray(trans)) throw new Error('resposta inesperada da API de transacoes');

  // Agrega por (ref, dia). Estornos vem como valores negativos e revisam o
  // dia na rodada seguinte, como nas demais lojas.
  const agreg = new Map();
  for (const t of trans) {
    const ref = String(t?.clickRefs?.clickRef || '').toLowerCase();
    if (!ref || !porRef.has(ref)) continue;
    const dia = String(t.transactionDate || '').slice(0, 10);
    if (!janela.includes(dia)) continue;
    const chave = ref + '|' + dia;
    const g = agreg.get(chave) || { ref, dia, pedidos: 0, vendas: 0, comissao: 0 };
    g.pedidos += 1;
    g.vendas = num(g.vendas + parseFloat(t?.saleAmount?.amount || 0));
    g.comissao = num(g.comissao + parseFloat(t?.commissionAmount?.amount || 0));
    agreg.set(chave, g);
  }

  let mudou = 0;
  for (const g of agreg.values()) {
    mudou += registrar(g.dia, porRef.get(g.ref), {
      cliques: 0, pedidos: g.pedidos, vendas: g.vendas, comissao: g.comissao,
    });
  }
  return mudou;
}

// ── consolidação ──────────────────────────────────────────────────────────

// Chave normalizada: a mesma para qualquer loja, para o ranking do painel poder
// ordenar Amazon, Shopee e ML na mesma tabela.
function chaveProduto(loja, asin) {
  return String(loja || '').toLowerCase().replace(/[^a-z]/g, '') + ':' + asin;
}

/**
 * Casa o que a plataforma reportou com o produto que foi disparado e grava o
 * acumulado. Recebe os dias já coletados; só toca no arquivo se algo mudou.
 */
async function desempenhoShopee(janela, inicioDoDia, fimDoDia, atribuicoes, registrar) {
  if (!SHOPEE_COOKIE || !SHOPEE_APP_ID || !SHOPEE_SECRET) {
    console.log('[desempenho] credenciais da Shopee ausentes — Shopee ignorada');
    return 0;
  }

  // ref -> atribuição mais recente daquele ref. Na Shopee o ref é
  // determinístico por item, então o mesmo ref reaparece em vários dias: o
  // registro serve só para saber QUAL produto é, não em que dia saiu.
  //
  // Filtro POSITIVO por loja: desde que ML/Magalu/Awin também registram refs
  // no ledger, "tudo que não é Amazon" deixou de significar Shopee — um SKU
  // numérico do Magalu pode colidir com um itemId da Shopee e roubar os
  // cliques dele no relatório.
  const porRef = new Map();
  for (const a of atribuicoes) {
    if (!a.ref || !String(a.loja || '').toLowerCase().includes('shopee')) continue;
    const ant = porRef.get(a.ref);
    if (!ant || (a.data || '') > (ant.data || '')) porRef.set(a.ref, a);
  }
  if (!porRef.size) { console.log('[desempenho] ledger sem refs da Shopee'); return 0; }

  let mudou = 0;
  for (const data of janela) {
    const [cliques, conversoes] = await Promise.all([
      shopeeCliquesPorSubId(inicioDoDia(data), fimDoDia(data)),
      shopeeConversaoPorSubId(inicioDoDia(data), fimDoDia(data)),
    ]);

    const refs = new Set([...Object.keys(cliques), ...Object.keys(conversoes)]);
    for (const ref of refs) {
      const attr = porRef.get(ref);
      if (!attr) continue; // ref que não saiu por nós (link antigo, outro canal)
      const conv = conversoes[ref] || { pedidos: 0, vendas: 0, comissao: 0 };
      mudou += registrar(data, attr, {
        cliques: cliques[ref] || 0,
        pedidos: conv.pedidos, vendas: conv.vendas, comissao: conv.comissao,
      });
    }
  }
  return mudou;
}

async function atualizarDesempenho(janela, inicioDoDia, fimDoDia) {
  if (!GH_TOKEN) throw new Error('GH_TOKEN_DADOS ausente');

  const { dados: ledger } = await lerJson(ARQ_RASTREIO, { atribuicoes: [] });
  const atribuicoes = ledger?.atribuicoes || [];
  if (!atribuicoes.length) {
    console.log('[desempenho] ledger vazio — nada disparado com marcação ainda');
    return;
  }

  const { dados: arquivo } = await lerJson(ARQ_DESEMPENHO, { produtos: {}, dias: {} });
  arquivo.produtos = arquivo.produtos || {};
  arquivo.dias = arquivo.dias || {};

  // Registrador comum: grava dia+produto no arquivo, pulando se nada mudou.
  // Retorna 1 se tocou o arquivo, 0 se o registro já era idêntico.
  const registrar = (data, attr, registro) => {
    const chave = chaveProduto(attr.loja, attr.asin);
    const doDia = (arquivo.dias[data] = arquivo.dias[data] || {});
    if (JSON.stringify(doDia[chave] || null) === JSON.stringify(registro)) return 0;
    doDia[chave] = registro;

    const p = arquivo.produtos[chave] || (arquivo.produtos[chave] = {
      loja: attr.loja || '', asin: attr.asin, nome: attr.nome || '', ref: attr.ref,
      cliques: 0, pedidos: 0, vendas: 0, comissao: 0, disparos: 0,
    });
    if (attr.nome && !p.nome) p.nome = attr.nome;
    p.ref = attr.ref;
    return 1;
  };

  // Vendas que NAO viram desempenho de um produto nosso, agregadas por produto
  // comprado: e o que o publico leva alem do que divulgamos — venda indireta
  // (entrou pelo nosso link e comprou outra coisa) ou produto ainda fora da
  // base. Vale para qualquer loja que exponha o item comprado.
  const naoAtribuidas = new Map();
  const coletarNaoAtribuida = (v) => {
    const chave = (v.loja || '?') + '|' + (v.id || v.nome || 'sem-id') + '|' + v.tipo;
    const g = naoAtribuidas.get(chave) || {
      loja: v.loja || '', id: v.id || null, tipo: v.tipo, nome: v.nome,
      categoria: v.categoria, vendedor: v.vendedor, link: v.link,
      unidades: 0, vendas: 0, comissao: 0, ocorrencias: 0, dias: [],
    };
    g.unidades += v.unidades;
    g.vendas = num(g.vendas + v.vendas);
    g.comissao = num(g.comissao + v.comissao);
    g.ocorrencias += 1;
    if (v.dia && !g.dias.includes(v.dia)) g.dias.push(v.dia);
    if (!g.nome && v.nome) g.nome = v.nome;
    naoAtribuidas.set(chave, g);
  };

  // Cada loja é isolada: falha em uma não derruba a outra nem a coleta principal.
  let mudou = 0;
  try {
    mudou += await desempenhoShopee(janela, inicioDoDia, fimDoDia, atribuicoes, registrar);
  } catch (e) {
    console.warn('[desempenho] Shopee falhou:', e.message);
  }
  try {
    mudou += await desempenhoAmazon(janela, atribuicoes, registrar, coletarNaoAtribuida);
  } catch (e) {
    console.warn('[desempenho] Amazon falhou:', e.message);
  }
  try {
    mudou += await desempenhoAwin(janela, atribuicoes, registrar);
  } catch (e) {
    console.warn('[desempenho] Awin falhou:', e.message);
  }
  try {
    mudou += await desempenhoMl(janela, atribuicoes, registrar, coletarNaoAtribuida);
  } catch (e) {
    console.warn('[desempenho] Mercado Livre falhou:', e.message);
  }

  // Arquivo proprio: e uma leitura de mercado, nao desempenho dos disparos —
  // misturar no ranking distorceria comissaoPorDisparo e conversao.
  if (naoAtribuidas.size) {
    const itens = [...naoAtribuidas.values()].sort((a, b) => b.comissao - a.comissao);
    const totais = itens.reduce((t, x) => ({
      unidades: t.unidades + x.unidades,
      vendas: num(t.vendas + x.vendas),
      comissao: num(t.comissao + x.comissao),
    }), { unidades: 0, vendas: 0, comissao: 0 });
    try {
      const porLoja = {};
      for (const x of itens) {
        const l = (porLoja[x.loja] = porLoja[x.loja] || { produtos: 0, unidades: 0, vendas: 0, comissao: 0 });
        l.produtos += 1; l.unidades += x.unidades;
        l.vendas = num(l.vendas + x.vendas); l.comissao = num(l.comissao + x.comissao);
      }
      await gravarJson(ARQ_DESCOBERTAS, {
        atualizadoEm: new Date().toISOString(),
        janela: { de: janela[0], ate: janela[janela.length - 1] },
        totais, porLoja, itens,
      }, `chore: vendas descobertas (${itens.length} produtos)`);
      console.log(`[desempenho] descobertas: ${itens.length} produtos `
        + `(R$ ${totais.comissao} em comissao) — ${Object.keys(porLoja).join(', ')}`);
    } catch (e) {
      console.warn('[desempenho] gravacao das vendas descobertas falhou:', e.message);
    }
  }

  if (!mudou) { console.log('[desempenho] nada novo'); return; }

  // Totais recalculados a partir dos dias — nunca incrementados, para que uma
  // rodada repetida não dobre o número.
  for (const chave of Object.keys(arquivo.produtos)) {
    const p = arquivo.produtos[chave];
    p.cliques = 0; p.pedidos = 0; p.vendas = 0; p.comissao = 0;
    for (const dia of Object.values(arquivo.dias)) {
      const d = dia[chave];
      if (!d) continue;
      p.cliques += d.cliques || 0;
      p.pedidos += d.pedidos || 0;
      p.vendas = num(p.vendas + (d.vendas || 0));
      p.comissao = num(p.comissao + (d.comissao || 0));
    }
    p.disparos = atribuicoes.filter((a) => chaveProduto(a.loja, a.asin) === chave).length;
    p.conversao = p.cliques ? Math.round((p.pedidos / p.cliques) * 1000) / 10 : null;
    p.comissaoPorDisparo = p.disparos ? num(p.comissao / p.disparos) : null;
  }

  arquivo.atualizadoEm = new Date().toISOString();
  await gravarJson(ARQ_DESEMPENHO, arquivo, `chore: desempenho por produto (${mudou} registros)`);
  console.log(`[desempenho] gravado — ${mudou} registro(s)`);
}

module.exports = { atualizarDesempenho };
