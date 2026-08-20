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
const ARQ_CATEGORIAS = process.env.ARQUIVO_CATEGORIAS || 'tsp/categorias-amazon.json';
// Ledger de EPC (ganho por clique) por ASIN. Diferente de desempenho-produtos,
// que so enxerga o que NOS divulgamos via tag, este cobre TODO produto comprado
// por quem entrou pelos nossos links — inclusive o que nunca foi divulgado e
// entrou por venda indireta. E a base de curadoria: prova demanda sem gastar um
// post para descobrir.
const ARQ_EPC = process.env.ARQUIVO_EPC || 'tsp/epc-produtos.json';
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
 * Produtos vinculados (aba "Produto relacionado" do painel): o que o publico
 * comprou tendo entrado por um link nosso.
 *
 * Vocabulario capturado da propria pagina em 17/08/2026 — os valores aceitos
 * em group_by sao linked_product, tag_id, purchased_asin_product_category,
 * day e top_seller; "asin" nao existe e por isso respondia 400 de corpo vazio.
 *
 * Aqui a Amazon entrega o que o ML nao entrega: direct_ordered_items e
 * indirect_ordered_items separados POR produto divulgado, ou seja, quanto de
 * venda indireta cada link nosso puxou.
 */
const COLUNAS_VINCULADOS = [
  'linked_product', 'linked_product_title', 'clicks',
  'indirect_ordered_items', 'direct_ordered_items', 'total_ordered_items',
  'total_ordered_revenue', 'shipped_items', 'shipped_revenue', 'total_earnings',
].join(',');

/**
 * Mapa asin -> categoria. O relatorio linked_product ignora qualquer coluna de
 * categoria que se peca (responde 200 sem o campo), mas o agrupamento
 * top_seller devolve asin e category juntos — e o unico lugar da API que
 * vincula os dois.
 *
 * O top_seller e ordenado por unidades, entao uma unica pagina cobre so os
 * campeoes da janela — e a cauda longa e justamente onde moram as compras nao
 * divulgadas, que sao o objeto desta coleta. Por isso paginamos: sem isso,
 * item que vendeu 1 unidade caia em "(sem categoria)" por construcao.
 */
const CAT_PAGINA = 200;
const CAT_MAX_PAGINAS = 6;
// Teto de paginas de produto lidas por rodada. O que passar disso fica para a
// proxima: com o cache, cada ASIN e lido uma unica vez na vida.
const CAT_MAX_LEITURAS = 40;
const CAT_PAUSA_LEITURA = 800;

/**
 * Categoria pelo breadcrumb da propria pagina do produto — fonte primaria.
 *
 * O relatorio da conta so conhece o topo: comprovado em rodada real, o
 * top_seller devolveu 9 pares asin/categoria para 13 produtos comprados, e nem
 * paginar (limit 200, 6 paginas) nem varrer dia a dia acrescentou uma linha.
 * Como Descobertas existe justamente para enxergar a cauda longa, depender do
 * relatorio era garantir que o item mais interessante caisse em "(sem
 * categoria)".
 *
 * A pagina do ASIN resolve todos e ainda usa sempre a mesma taxonomia, o que
 * mantem o grafico "onde esta o dinheiro" somavel. Guardamos o caminho inteiro
 * e usamos o primeiro nivel como rotulo: departamento e o recorte que responde
 * "o que o publico compra", subcategoria fragmentaria demais.
 */
async function categoriaDaPagina(asin) {
  // O IP do runner do Actions e datacenter: sem sessao, a Amazon devolve 200
  // com uma pagina-toco de ~3,9 KB e nenhum conteudo (comprovado em rodada
  // real). Reaproveitamos o AMAZON_COOKIE da coleta — os cookies de sessao sao
  // de dominio .amazon.com.br, entao valem tambem na vitrine — e mandamos o
  // conjunto de cabecalhos que um navegador manda numa navegacao de topo.
  const r = await req('https://www.amazon.com.br/dp/' + asin, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'no-cache',
      ...(AMAZON_COOKIE ? { Cookie: AMAZON_COOKIE } : {}),
    },
    redirect: 'follow',
  }, 20000);
  if (!r.ok) { console.log(`[desempenho] Amazon: pagina ${asin} status ${r.status}`); return null; }
  const html = await r.text();
  const bloco = html.match(/wayfinding-breadcrumbs_feature_div([\s\S]{0,4000}?)<\/ul>/);
  if (!bloco) {
    // Parte das paginas nao traz breadcrumb, mas o title termina com o
    // departamento ("... : Amazon.com.br: Alimentos e Bebidas") — mesma
    // taxonomia, entao vale como segunda leitura antes de desistir.
    const t = (html.match(/<title>([\s\S]{0,200}?)<\/title>/) || [, ''])[1].trim();
    const dep = (t.match(/Amazon\.com\.br\s*:\s*([^:|]{3,60})\s*$/) || [])[1];
    if (dep) return { categoria: dep.trim(), caminho: dep.trim() };
    // Sem breadcrumb nem departamento no title = captcha, ASIN morto ou layout
    // novo. Nos tres casos nao ha o que inventar: o relatorio decide.
    console.log(`[desempenho] Amazon: pagina ${asin} sem categoria — ${html.length} bytes, `
      + `title="${t.slice(0, 90) || '(sem title)'}"`);
    return null;
  }
  const trilha = [...bloco[1].matchAll(/>\s*([^<>]{2,60}?)\s*</g)]
    .map((m) => m[1].trim())
    .filter((t) => t && t !== '\u203a' && !/^&\w+;$/.test(t));
  if (!trilha.length) return null;
  return { categoria: trilha[0], caminho: trilha.slice(0, 5).join(' > ') };
}

/**
 * Le a pagina dos ASIN que o cache ainda nao conhece, em serie e com pausa —
 * paralelizar leitura de vitrine e o caminho curto para tomar bloqueio, e esta
 * coleta nao tem pressa nenhuma.
 */
async function categoriasPorPagina(asins) {
  const mapa = new Map();
  if (!asins.length) return mapa;
  let falhas = 0;
  for (const asin of asins.slice(0, CAT_MAX_LEITURAS)) {
    try {
      const achado = await categoriaDaPagina(asin);
      if (achado) mapa.set(asin, achado); else falhas++;
    } catch (e) {
      falhas++;
    }
    await new Promise((res) => setTimeout(res, CAT_PAUSA_LEITURA));
  }
  const lidos = Math.min(asins.length, CAT_MAX_LEITURAS);
  console.log(`[desempenho] Amazon: categoria por pagina — ${mapa.size}/${lidos} resolvido(s)`
    + (falhas ? `, ${falhas} sem breadcrumb` : '')
    + (asins.length > lidos ? `, ${asins.length - lidos} adiado(s) para a proxima rodada` : ''));
  return mapa;
}

/**
 * Fonte secundaria: o unico relatorio da API que traz asin e categoria na
 * mesma linha. Fica so como rede de seguranca para o ASIN cuja pagina nao
 * abriu. Testados e descartados por responderem total_results:0 —
 * earnings/product, earnings/asin, orders/product.
 */
const REL_TOP_SELLER = {
  nome: 'top_seller', type: 'overview', group_by: 'top_seller',
  columns: 'rank,product,category,purchase_type', sort: 'total_ordered_items',
};

// O nome dos campos varia entre relatorios (asin solto, product aninhado,
// category como texto ou objeto). Normalizar aqui evita que uma mudanca de
// forma da API vire categoria vazia silenciosa.
function parAsinCategoria(it) {
  const bruto = it.asin || it.product_asin || it.linked_product
    || (it.product && (it.product.asin || it.product.id)) || '';
  const asin = String(bruto).toUpperCase();
  const cat = it.category || it.category_name || it.product_category || '';
  const nome = typeof cat === 'object' && cat ? (cat.name || cat.label || '') : cat;
  return asin && nome ? [asin, String(nome)] : null;
}

async function amazonCategoriasPorAsin(ctx, de, ate) {
  const mapa = new Map();
  let token = '';
  for (let pagina = 0; pagina < CAT_MAX_PAGINAS; pagina++) {
    const qs = new URLSearchParams({
      'query[type]': REL_TOP_SELLER.type,
      'query[start_date]': de, 'query[end_date]': ate,
      'query[group_by]': REL_TOP_SELLER.group_by,
      'query[columns]': REL_TOP_SELLER.columns,
      'query[order]': 'desc', 'query[sort]': REL_TOP_SELLER.sort,
      'query[skip]': String(pagina * CAT_PAGINA),
      'query[limit]': String(CAT_PAGINA),
      'query[next_token]': token,
      'query[storeId]': ctx.storeId, 'query[locale]': 'BR',
      store_id: ctx.storeId,
    });
    const r = await req('https://associados.amazon.com.br/reporting/table?' + qs.toString(),
      { headers: ctx.headers });
    // Falha no meio da paginacao devolve o que ja foi lido: categoria parcial
    // e melhor que nenhuma, e a coleta principal nao depende disto.
    if (!r.ok) break;
    let j;
    try { j = await r.json(); } catch (e) { break; }
    const registros = j.records || j.rows || [];
    for (const it of registros) {
      const par = parAsinCategoria(it);
      if (par) mapa.set(par[0], par[1]);
    }
    // A API ora pagina por skip, ora por next_token; mandamos os dois e
    // paramos quando a pagina vem incompleta, que vale nos dois modos.
    token = j.nextToken || j.next_token || '';
    if (registros.length < CAT_PAGINA) break;
    await new Promise((res) => setTimeout(res, 400));
  }
  return mapa;
}

// Cache persistente asin -> categoria (cdv-tsp-dados). O top_seller so enxerga
// a janela corrente: um ASIN visto ontem e ausente do top de hoje voltaria a
// ficar sem categoria. Guardando o que ja foi descoberto, cada rodada precisa
// resolver apenas o que e novo — e o rotulo para de oscilar entre as coletas.
const CAT_VALIDADE_DIAS = 180;
const CAT_REFRESCO_DIAS = 30;

async function carregarCategoriasSalvas() {
  try {
    const { dados } = await lerJson(ARQ_CATEGORIAS, { categorias: {} });
    return dados?.categorias || {};
  } catch (e) {
    console.warn('[desempenho] Amazon: cache de categorias ilegivel —', e.message);
    return {};
  }
}

function diaISO(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function salvarCategorias(salvas, conhecidas) {
  const hoje = diaISO(Date.now());
  const corte = diaISO(Date.now() - CAT_REFRESCO_DIAS * 86400000);
  let novos = 0, refrescados = 0;

  for (const [asin, achado] of conhecidas) {
    const reg = typeof achado === 'string' ? { categoria: achado, fonte: 'relatorio' } : achado;
    if (!reg || !reg.categoria) continue;
    const atual = salvas[asin];
    if (!atual || atual.categoria !== reg.categoria) {
      salvas[asin] = {
        categoria: reg.categoria, caminho: reg.caminho || '',
        fonte: reg.fonte || 'pagina', visto: hoje,
      };
      novos++;
    } else if ((atual.visto || '') < corte) {
      // Marca de uso: ASIN que continua vendendo nao pode ser podado so por
      // ter saido do top_seller. So reescrevemos quando a marca ja envelheceu,
      // para nao gerar commit diario sem conteudo novo.
      atual.visto = hoje;
      refrescados++;
    }
  }

  // Poda: ASIN sem sinal ha meses nao volta e so infla o arquivo.
  const limite = diaISO(Date.now() - CAT_VALIDADE_DIAS * 86400000);
  let podados = 0;
  for (const asin of Object.keys(salvas)) {
    if ((salvas[asin].visto || '') < limite) { delete salvas[asin]; podados++; }
  }

  if (!novos && !refrescados && !podados) return;
  await gravarJson(ARQ_CATEGORIAS, {
    atualizadoEm: new Date().toISOString(),
    total: Object.keys(salvas).length,
    categorias: salvas,
  }, `chore: categorias Amazon (+${novos} / -${podados})`);
  console.log(`[desempenho] Amazon: categorias +${novos} nova(s), ${refrescados} refrescada(s), `
    + `-${podados} podada(s) — ${Object.keys(salvas).length} no cache`);
}

// 429 aconteceu de verdade numa rodada agendada e custou a Amazon inteira no
// painel. O relatorio nao tem pressa: esperar e tentar de novo sai muito mais
// barato que perder o dia.
const VINC_ESPERAS = [5000, 15000, 40000];

async function amazonProdutosVinculadosPagina(ctx, de, ate, skip, token) {
  const qs = new URLSearchParams({
    'query[type]': 'overview',
    'query[start_date]': de, 'query[end_date]': ate,
    'query[group_by]': 'linked_product',
    'query[columns]': COLUNAS_VINCULADOS,
    'query[order]': 'desc', 'query[sort]': 'total_ordered_items',
    'query[skip]': String(skip), 'query[limit]': String(CAT_PAGINA),
    'query[next_token]': token || '',
    'query[storeId]': ctx.storeId, 'query[locale]': 'BR',
    store_id: ctx.storeId,
  });
  for (let tent = 0; ; tent++) {
    const r = await req('https://associados.amazon.com.br/reporting/table?' + qs.toString(),
      { headers: ctx.headers });
    if (r.status === 401) throw new Error('API recusou o token (401) — renove AMAZON_COOKIE');
    if (r.ok) return r.json();
    if (![429, 500, 502, 503].includes(r.status) || tent >= VINC_ESPERAS.length) {
      throw new Error(`produtos vinculados: status ${r.status}`);
    }
    console.log(`[desempenho] Amazon: vinculados status ${r.status}, `
      + `nova tentativa em ${VINC_ESPERAS[tent] / 1000}s`);
    await new Promise((res) => setTimeout(res, VINC_ESPERAS[tent]));
  }
}

// Paginado: com limit fixo em 200, uma operacao que crescesse passaria a
// perder produto sem avisar — a listagem simplesmente terminaria no 200o.
async function amazonProdutosVinculados(ctx, de, ate) {
  const linhas = [];
  let token = '';
  for (let pagina = 0; pagina < CAT_MAX_PAGINAS; pagina++) {
    const j = await amazonProdutosVinculadosPagina(ctx, de, ate, pagina * CAT_PAGINA, token);
    const registros = j.records || [];
    linhas.push(...registros);
    token = j.nextToken || j.next_token || '';
    if (registros.length < CAT_PAGINA) break;
    await new Promise((res) => setTimeout(res, 400));
  }
  return linhas;
}

// ── LEDGER DE EPC POR ASIN ────────────────────────────────────────────────
//
// Por que existe: ordenar produto por "quantas unidades vendeu" premia item
// barato de giro alto e esconde o que realmente paga. O que decide se vale
// gastar um post e o GANHO POR CLIQUE — o iPad Air puxou 242 cliques e rendeu
// R$ 0,28 por clique; o vinho DV Catena puxou 153 e rendeu R$ 4,55. Os dois
// aparecem lado a lado num ranking por unidades.
//
// Acumulacao DIA A DIA, nunca por janela: o relatorio e agregado, entao somar
// janelas que se sobrepoem contaria a mesma venda varias vezes. Cada dia e
// coletado uma unica vez e fica gravado; o total e sempre recalculado a partir
// dos dias, para uma rodada repetida nao dobrar numero nenhum.
const EPC_RETENCAO_DIAS = 180;
// Teto de dias novos por rodada. A primeira rodada tem uma janela inteira em
// aberto e o Actions tem tempo limitado; o resto entra nas rodadas seguintes.
const EPC_MAX_DIAS_RODADA = 8;
// Horizonte do EPC publicado. Comportamento de compra de 6 meses atras nao
// descreve o publico de hoje.
const EPC_JANELA_DIAS = 90;

/**
 * Separa comissao DIRETA de INDIRETA no ledger de EPC.
 *
 * O problema: `epc-produtos.json` e montado do relatorio de produtos VINCULADOS,
 * que atribui tudo ao item CLICADO. Quando a pessoa clica num link e compra
 * outra coisa nas 24h — que e a regra, nao a excecao — a comissao aparece no
 * item comprado, nao no clicado. O resultado e um ledger em que produto com
 * dezenas de cliques e vendas reais figura com comissao zero.
 *
 * Caso medido em 19/08: soundcore P40i com 53 cliques e R$ 0,00 no EPC,
 * enquanto vendas-descobertas registrava 22 unidades e R$ 80,81 no MESMO
 * periodo. Os dois numeros estao certos — respondem perguntas diferentes.
 *
 * Aqui os dois viram campos separados, sem que um sobrescreva o outro:
 *   comissao / epc              o que o relatorio de vinculados atribuiu (direta)
 *   comissaoIndireta            o que o produto rendeu sendo comprado, nao clicado
 *   epcTotal                    (direta + indireta) / cliques
 */
async function cruzarEpcComDescobertas(itensDescobertos) {
  const { dados: led } = await lerJson(ARQ_EPC, null);
  if (!led || !led.produtos) return;

  const porId = new Map();
  for (const it of itensDescobertos || []) {
    const id = String(it.id || '').toUpperCase();
    if (!/^B[A-Z0-9]{9}$/.test(id)) continue;          // ledger de EPC e so Amazon
    const a = porId.get(id) || { comissao: 0, unidades: 0 };
    a.comissao = num(a.comissao + (it.comissao || 0));
    a.unidades += it.unidades || 0;
    porId.set(id, a);
  }

  let tocados = 0;
  for (const [asin, p] of Object.entries(led.produtos)) {
    const ind = porId.get(asin);
    const indComis = ind ? ind.comissao : 0;
    const indUnid  = ind ? ind.unidades : 0;
    const antes = p.comissaoIndireta ?? null;
    p.comissaoIndireta = indComis;
    p.unidadesIndiretas = indUnid;
    p.epcTotal = p.cliques
      ? Math.round(((p.comissao + indComis) / p.cliques) * 100) / 100 : 0;
    if (antes !== indComis) tocados++;
  }

  led.atualizadoEm = new Date().toISOString();
  await gravarJson(ARQ_EPC, led,
    `chore: EPC cruzado com vendas descobertas (${tocados} produto(s) com comissao indireta)`);
  console.log(`[desempenho] EPC cruzado: ${tocados} produto(s) ganharam comissao indireta`);
}

function epcVazio() {
  return { atualizadoEm: null, dias: {}, produtos: {} };
}

/**
 * Coleta os dias que faltam e reescreve o ledger. Devolve o numero de dias
 * novos coletados (0 = nada a fazer).
 */
async function acumularEpcAmazon(ctx, janela, categoriaDe) {
  const { dados } = await lerJson(ARQ_EPC, null);
  const led = (dados && typeof dados === 'object' && dados.dias) ? dados : epcVazio();

  // Dia de hoje nunca entra: o relatorio ainda esta sendo escrito e o numero
  // parcial ficaria congelado como se fosse o fechamento.
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const faltando = [...janela].sort()
    .filter((d) => d < hoje && !led.dias[d])
    .slice(-EPC_MAX_DIAS_RODADA);

  if (!faltando.length) {
    console.log('[desempenho] EPC: nenhum dia novo a coletar');
    return 0;
  }

  let novos = 0;
  for (const dia of faltando) {
    let linhas;
    try { linhas = await amazonProdutosVinculados(ctx, dia, dia); }
    catch (e) { console.warn(`[desempenho] EPC ${dia}: ${e.message}`); continue; }

    const doDia = {};
    for (const it of linhas) {
      const asin = String(it.linked_product || '').toUpperCase();
      if (!/^B[A-Z0-9]{9}$/.test(asin)) continue;
      const reg = {
        c: Math.round(numApi(it.clicks)),
        p: Math.round(numApi(it.total_ordered_items)),
        r: num(numApi(it.shipped_revenue ?? it.total_ordered_revenue)),
        g: num(numApi(it.total_earnings)),
      };
      if (!reg.c && !reg.p && !reg.g) continue;
      doDia[asin] = reg;

      const nome = it.linked_product_title || '';
      const p = led.produtos[asin] || (led.produtos[asin] = { asin, nome: '', categoria: '' });
      if (nome && !p.nome) p.nome = nome;
      const cat = categoriaDe ? categoriaDe(asin) : '';
      if (cat && !p.categoria) p.categoria = cat;
    }
    // Dia gravado mesmo vazio: sem isso ele seria recoletado para sempre.
    led.dias[dia] = doDia;
    novos++;
    await new Promise((res) => setTimeout(res, 500));
  }

  // Poda e recalculo. Totais SEMPRE derivados dos dias — nunca incrementados.
  const corte = new Date(Date.now() - EPC_RETENCAO_DIAS * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(led.dias)) if (d < corte) delete led.dias[d];

  const corteJanela = new Date(Date.now() - EPC_JANELA_DIAS * 86400000).toISOString().slice(0, 10);
  const acc = {};
  for (const [dia, itens] of Object.entries(led.dias)) {
    if (dia < corteJanela) continue;
    for (const [asin, r] of Object.entries(itens)) {
      const a = acc[asin] || (acc[asin] = { cliques: 0, pedidos: 0, receita: 0, comissao: 0, dias: 0,
                                            primeiroDia: dia, ultimoDia: dia });
      a.cliques += r.c; a.pedidos += r.p;
      a.receita = num(a.receita + r.r); a.comissao = num(a.comissao + r.g);
      a.dias += 1;
      if (dia < a.primeiroDia) a.primeiroDia = dia;
      if (dia > a.ultimoDia) a.ultimoDia = dia;
    }
  }

  for (const asin of Object.keys(led.produtos)) {
    const a = acc[asin];
    const p = led.produtos[asin];
    if (!a) {
      // Fora da janela de 90 dias: o produto some do ranking, mas o cadastro
      // (nome, categoria) fica — e barato e evita reaprender tudo se voltar.
      Object.assign(p, { cliques: 0, pedidos: 0, receita: 0, comissao: 0, dias: 0,
                         epc: 0, conversao: 0, ticket: 0 });
      continue;
    }
    Object.assign(p, a, {
      epc: a.cliques ? Math.round((a.comissao / a.cliques) * 100) / 100 : 0,
      // Acima de 100% e venda indireta: a pessoa clicou aqui e comprou isto
      // sem que este produto tivesse sido divulgado. Nao e erro — e o sinal
      // mais valioso do relatorio.
      conversao: a.cliques ? Math.round((a.pedidos / a.cliques) * 1000) / 10 : null,
      ticket: a.pedidos ? Math.round((a.receita / a.pedidos) * 100) / 100 : 0,
    });
  }

  led.atualizadoEm = new Date().toISOString();
  led.janelaDias = EPC_JANELA_DIAS;

  const ranking = Object.values(led.produtos).filter((p) => p.cliques > 0)
    .sort((a, b) => b.comissao - a.comissao);
  led.totais = ranking.reduce((t, p) => ({
    produtos: t.produtos + 1, cliques: t.cliques + p.cliques, pedidos: t.pedidos + p.pedidos,
    receita: num(t.receita + p.receita), comissao: num(t.comissao + p.comissao),
  }), { produtos: 0, cliques: 0, pedidos: 0, receita: 0, comissao: 0 });
  led.totais.epc = led.totais.cliques
    ? Math.round((led.totais.comissao / led.totais.cliques) * 100) / 100 : 0;

  await gravarJson(ARQ_EPC, led, `chore: ledger de EPC (${novos} dia(s) novo(s), ${ranking.length} produtos)`);
  console.log(`[desempenho] EPC: ${novos} dia(s) coletado(s), ${ranking.length} produto(s) `
    + `na janela de ${EPC_JANELA_DIAS}d, EPC medio R$ ${led.totais.epc}`);
  return novos;
}

async function desempenhoAmazon(janela, atribuicoes, registrar, coletarNaoAtribuida, marcarColeta) {
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

  // Produtos comprados na janela: o ledger diz quais divulgamos, e o resto e
  // leitura de mercado. Como a Amazon separa direto de indireto por produto,
  // registramos os dois lados — ate para item que JA esta no ledger, porque a
  // parcela indireta dele nao e desempenho do disparo.
  if (coletarNaoAtribuida) {
    try {
      const dias = [...janela].sort();
      const doLedger = new Set(atribuicoes
        .filter((a) => /amazon/i.test(String(a.loja || '')))
        .map((a) => String(a.asin || '').toUpperCase()));
      const vinculados = await amazonProdutosVinculados(ctx, dias[0], dias[dias.length - 1]);
      // A listagem chegou inteira: o que a loja tem a dizer nesta janela ja e
      // conhecido, ainda que dela nao saia nenhuma descoberta.
      marcarColeta?.('Amazon');
      // Categoria vem de outro agrupamento; falha aqui nao pode custar a coleta.
      const salvas = await carregarCategoriasSalvas();
      // Alvos = ASIN comprado nesta janela que o cache ainda nao conhece. Em
      // regime, essa lista e quase sempre pequena: so produto inedito entra.
      // Entrada vinda do relatorio e provisoria: usa outra taxonomia e conviveria
      // com a da pagina no mesmo grafico, partindo o balde em dois. Por isso ela
      // continua na fila de alvos ate a pagina responder e substituir o rotulo.
      const resolvido = (a) => salvas[a] && salvas[a].categoria && salvas[a].fonte === 'pagina';
      const alvos = [];
      for (const it of vinculados) {
        const a = String(it.linked_product || '').toUpperCase();
        if (a && !resolvido(a) && !alvos.includes(a)) alvos.push(a);
      }

      const porPagina = await categoriasPorPagina(alvos);

      // Relatorio so entra se a pagina deixou buraco — nao gasta chamada a toa.
      let porApi = new Map();
      if (alvos.some((a) => !porPagina.has(a))) {
        try { porApi = await amazonCategoriasPorAsin(ctx, dias[0], dias[dias.length - 1]); }
        catch (e) { console.warn('[desempenho] Amazon: top_seller falhou —', e.message); }
      }

      // Ordem: pagina desta rodada > cache > relatorio. A pagina vem primeiro
      // justamente para poder promover uma entrada provisoria do cache.
      const aplicadas = new Map();
      const categoriaDe = (asin) => {
        const pag = porPagina.get(asin);
        if (pag) { aplicadas.set(asin, { ...pag, fonte: 'pagina' }); return pag.categoria; }
        const salvo = salvas[asin] && salvas[asin].categoria;
        if (salvo) { aplicadas.set(asin, salvas[asin]); return salvo; }
        const api = porApi.get(asin);
        if (api) { aplicadas.set(asin, { categoria: api, fonte: 'relatorio' }); return api; }
        return '';
      };
      let semCategoria = 0;
      for (const it of vinculados) {
        const asin = String(it.linked_product || '').toUpperCase();
        if (!asin) continue;
        const indiretos = Math.round(numApi(it.indirect_ordered_items));
        const total = Math.round(numApi(it.total_ordered_items));
        const noLedger = doLedger.has(asin);
        // Item divulgado sem parcela indireta ja esta coberto pelo desempenho
        // por tag: repetir aqui seria contar a mesma venda duas vezes.
        if (noLedger && !indiretos) continue;
        const unidades = noLedger ? indiretos : total;
        if (!unidades) continue;
        const proporcao = total > 0 ? unidades / total : 1;
        if (!categoriaDe(asin)) semCategoria++;
        coletarNaoAtribuida({
          loja: 'Amazon', id: asin, dia: null,
          tipo: noLedger ? 'indireta' : 'nao_divulgado',
          nome: it.linked_product_title || '', categoria: categoriaDe(asin), vendedor: '',
          link: 'https://www.amazon.com.br/dp/' + asin,
          unidades,
          vendas: num(numApi(it.shipped_revenue ?? it.total_ordered_revenue) * proporcao),
          comissao: num(numApi(it.total_earnings) * proporcao),
        });
      }
      if (semCategoria) {
        console.log(`[desempenho] Amazon: ${semCategoria} produto(s) seguem sem categoria`);
      }
      // Cache atualizado depois do uso: assim a marca de uso cobre tambem o
      // ASIN que veio do cache e nao apareceu no top_seller desta janela.
      try { await salvarCategorias(salvas, aplicadas); }
      catch (e) { console.warn('[desempenho] Amazon: cache de categorias nao gravou —', e.message); }

      // Ledger de EPC: mesma fonte (produtos vinculados), outra pergunta. As
      // descobertas respondem "o que o publico comprou alem do que divulgamos";
      // o EPC responde "quanto cada produto paga por clique gasto". Roda por
      // ultimo e em try proprio — e enriquecimento, nao pode custar a coleta.
      try { await acumularEpcAmazon(ctx, dias, categoriaDe); }
      catch (e) { console.warn('[desempenho] EPC: acumulacao falhou —', e.message); }
    } catch (e) {
      console.warn('[desempenho] Amazon: produtos vinculados falhou —', e.message);
    }
  }
  return mudou;
}

// ── Mercado Livre por produto ─────────────────────────────────────────────
//
// O relatorio /dashboard/sales/general lista VENDAS, uma por linha, com o link
// do produto comprado. So as vendas DIRECT (item comprado == item divulgado)
// sao atribuiveis por produto; as INDIRECT vem de quem clicou no nosso link e
// comprou outra coisa, e somar essas ao produto divulgado seria inventar
// atribuicao. Cliques por produto o painel nao expoe em nenhuma aba — o ML
// fica com conversao e comissao, sem clique.
//
// Origem da venda indireta: subIdMlDaLinha() varre o payload atras de um campo
// de sub_id/tag e cai no link como plano B. O log de campos diz, a cada coleta,
// o que o ML devolve de fato. Enquanto o disparo do ML sair com a URL intacta
// (decisao de radar-amazon.js, para nao arriscar a atribuicao da rede), nao ha
// marcacao nossa para o relatorio devolver e a origem fica nula.
//
// O ledger guarda o id no formato MLB{n}; os links vem como
// /MLB-{n}-slug (item) ou /up/MLBU{n} (catalogo unificado, id diferente).

// Sonda de origem no ML. Hoje o link do ML sai do disparo SEM parametro extra
// (radar-amazon.js: aplicarRefNoLink devolve a URL intacta para ML), entao nao
// existe sub_id nosso para o relatorio devolver. Esta funcao serve para duas
// coisas: (a) provar isso com o payload real, via o log de campos abaixo, e
// (b) passar a atribuir sozinha no dia em que o disparo comecar a marcar a URL.
const CAMPOS_SUBID_ML = [
  'subId', 'sub_id', 'subid', 'sub_ids', 'tag', 'tagName', 'tag_name',
  'mattWord', 'matt_word', 'mattTool', 'matt_tool', 'sourceId', 'source_id',
  'customTag', 'custom_tag', 'trackingId', 'tracking_id', 'campaign', 'campaignName',
];

function subIdMlDaLinha(x) {
  for (const campo of CAMPOS_SUBID_ML) {
    const v = x && x[campo];
    if (v == null) continue;
    const s = Array.isArray(v) ? String(v[0] || '') : String(v);
    if (s && s !== 'null' && s !== 'undefined') return s.toLowerCase();
  }
  // Plano B: o proprio link da venda pode carregar a marcacao na query.
  try {
    const u = new URL(String(x?.link || ''));
    for (const campo of ['matt_word', 'matt_tool', 'sub_id1', 'subid', 'tag']) {
      const v = u.searchParams.get(campo);
      if (v) return String(v).toLowerCase();
    }
  } catch { /* link relativo ou vazio: sem origem, segue sem */ }
  return null;
}

// Roda uma vez por coleta: lista os campos que o ML devolve de fato. E o unico
// jeito honesto de responder "da para atribuir venda indireta no ML?" — sem
// isso a resposta seria chute sobre um payload que muda sem aviso.
let _camposMlLogados = false;
function logarCamposMl(linha) {
  if (_camposMlLogados || !linha) return;
  _camposMlLogados = true;
  const campos = Object.keys(linha).sort();
  console.log('[desempenho] ML: campos da linha de venda —', campos.join(', '));
  const achados = CAMPOS_SUBID_ML.filter((k) => linha[k] != null);
  console.log(achados.length
    ? `[desempenho] ML: campo(s) de origem presente(s) — ${achados.join(', ')}`
    : '[desempenho] ML: nenhum campo de sub_id/tag no payload — venda indireta segue sem origem');
}

const idMlDoLink = (url) => {
  const s = String(url || '');
  const mu = s.match(/\/up\/(MLBU\d{6,})/i);
  if (mu) return mu[1].toUpperCase();
  const m = s.match(/\bMLB-?(\d{6,})/i);
  return m ? 'MLB' + m[1] : null;
};

async function desempenhoMl(janela, atribuicoes, registrar, coletarNaoAtribuida, marcarColeta) {
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
  marcarColeta?.('Mercado Livre');

  logarCamposMl(linhas[0]);

  // ref -> atribuicao, para traduzir um eventual sub_id de volta ao produto que
  // divulgamos. Enquanto o ML nao devolver origem, o mapa fica sem uso — e de
  // proposito: no dia em que devolver, a atribuicao passa a sair sozinha.
  const porRefMl = new Map();
  for (const a of atribuicoes) {
    if (!/mercado\s*livre/i.test(String(a.loja || '')) || !a.ref) continue;
    const ant = porRefMl.get(a.ref);
    if (!ant || (a.data || '') > (ant.data || '')) porRefMl.set(String(a.ref).toLowerCase(), a);
  }
  let comOrigem = 0;

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
      const origem = porRefMl.get(subIdMlDaLinha(x) || '') || null;
      if (origem) comOrigem++;
      coletarNaoAtribuida?.({
        loja: 'Mercado Livre',
        id, dia, tipo: direta ? 'direta_fora_do_ledger' : 'indireta',
        refOrigem: origem ? origem.ref : null,
        origemId: origem ? origem.asin : null,
        origemNome: origem ? (origem.nome || '') : '',
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
    console.log(`[desempenho] ML: ${indiretas} vendas indiretas, ${semCasar} diretas sem produto no ledger`
      + ` — ${comOrigem} com link de origem identificado`);
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
/**
 * Itens comprados por conversao, com o sub_id que originou. Serve para separar
 * o que o publico levou alem do produto divulgado: se o item comprado nao e o
 * do ref, e venda indireta; se nao ha ref nosso, e compra de link antigo ou de
 * outro canal e fica de fora.
 */
async function shopeeItensComprados(inicio, fim) {
  const campo = await descobrirCampoSubId();
  if (!campo) return [];

  const saida = [];
  let scrollId = null, guard = 0;
  do {
    const sc = scrollId ? `, scrollId:"${scrollId}"` : '';
    const d = await shopeeGql(`{ conversionReport(purchaseTimeStart:${inicio}, `
      + `purchaseTimeEnd:${fim}, limit:500${sc}){ `
      + `nodes { ${campo} orders { items { itemId itemName itemPrice qty `
      + 'actualAmount itemTotalCommission globalCategoryLv1Name shopName } } } '
      + 'pageInfo { hasNextPage scrollId } } }');

    const rep = d?.conversionReport;
    if (!rep) break;
    for (const n of rep.nodes || []) {
      const bruto = n[campo];
      const ref = Array.isArray(bruto) ? String(bruto[0] || '') : String(bruto || '');
      for (const o of n.orders || []) {
        for (const it of o.items || []) saida.push({ ref, item: it });
      }
    }
    scrollId = rep.pageInfo?.hasNextPage ? rep.pageInfo.scrollId : null;
  } while (scrollId && ++guard < 30);

  return saida;
}

async function desempenhoShopee(janela, inicioDoDia, fimDoDia, atribuicoes, registrar, coletarNaoAtribuida, marcarColeta) {
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

    // O item comprado nem sempre e o divulgado: quando difere, e venda
    // indireta e vira leitura de mercado, nao desempenho daquele disparo.
    if (coletarNaoAtribuida) {
      try {
        const comprados = await shopeeItensComprados(inicioDoDia(data), fimDoDia(data));
        marcarColeta?.('Shopee');
        for (const { ref, item } of comprados) {
          const attr = porRef.get(ref);
          if (!attr) continue;
          const idComprado = String(item.itemId || '');
          if (!idComprado || idComprado === String(attr.asin || '')) continue;
          coletarNaoAtribuida({
            loja: 'Shopee', id: idComprado, dia: data, tipo: 'indireta',
            // Quem clicou entrou por ESTE disparo e levou outra coisa: o par
            // ref -> produto divulgado e o que responde "de qual link veio".
            refOrigem: attr.ref, origemId: attr.asin || null, origemNome: attr.nome || '',
            nome: item.itemName || '', categoria: item.globalCategoryLv1Name || '',
            vendedor: item.shopName || '',
            link: 'https://shopee.com.br/product/0/' + idComprado,
            unidades: Math.max(1, parseInt(item.qty, 10) || 1),
            vendas: parseFloat(item.actualAmount || item.itemPrice || 0) || 0,
            comissao: parseFloat(item.itemTotalCommission || 0) || 0,
          });
        }
      } catch (e) {
        console.warn(`[desempenho] Shopee: itens comprados ${data} —`, e.message);
      }
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
  // Loja cuja fonte respondeu nesta rodada. O arquivo de descobertas e
  // reescrito por inteiro, entao sem esta marca um 429 transitorio na Amazon
  // apagava a Amazon do painel ate a proxima rodada dar certo — foi o que
  // aconteceu na rodada agendada de 18/08.
  const lojasColetadas = new Set();
  const marcarColeta = (loja) => { if (loja) lojasColetadas.add(loja); };

  const naoAtribuidas = new Map();
  const coletarNaoAtribuida = (v) => {
    const chave = (v.loja || '?') + '|' + (v.id || v.nome || 'sem-id') + '|' + v.tipo;
    const g = naoAtribuidas.get(chave) || {
      loja: v.loja || '', id: v.id || null, tipo: v.tipo, nome: v.nome,
      categoria: v.categoria, vendedor: v.vendedor, link: v.link,
      unidades: 0, vendas: 0, comissao: 0, ocorrencias: 0, dias: [], origens: [],
    };
    g.unidades += v.unidades;
    g.vendas = num(g.vendas + v.vendas);
    g.comissao = num(g.comissao + v.comissao);
    g.ocorrencias += 1;
    if (v.dia && !g.dias.includes(v.dia)) g.dias.push(v.dia);
    // Origem = o disparo NOSSO que levou o clique que virou esta venda. So a
    // Shopee entrega isso hoje (o relatorio vem por sub_id). Guardar por venda
    // e nao por produto porque o mesmo item pode ter vindo de dois links.
    if (v.refOrigem) {
      const o = g.origens.find((x) => x.ref === v.refOrigem);
      if (o) {
        o.unidades += v.unidades;
        o.comissao = num(o.comissao + v.comissao);
        o.ocorrencias += 1;
      } else {
        g.origens.push({
          ref: v.refOrigem, id: v.origemId || null, nome: v.origemNome || '',
          unidades: v.unidades, comissao: num(v.comissao), ocorrencias: 1,
        });
      }
    }
    // O grupo nasce com os campos da primeira ocorrencia; se ela veio incompleta
    // (categoria vazia, por exemplo), a proxima preenche em vez de descartar.
    if (!g.nome && v.nome) g.nome = v.nome;
    if (!g.categoria && v.categoria) g.categoria = v.categoria;
    if (!g.vendedor && v.vendedor) g.vendedor = v.vendedor;
    if (!g.link && v.link) g.link = v.link;
    naoAtribuidas.set(chave, g);
  };

  // Cada loja é isolada: falha em uma não derruba a outra nem a coleta principal.
  let mudou = 0;
  try {
    mudou += await desempenhoShopee(janela, inicioDoDia, fimDoDia, atribuicoes, registrar, coletarNaoAtribuida, marcarColeta);
  } catch (e) {
    console.warn('[desempenho] Shopee falhou:', e.message);
  }
  try {
    mudou += await desempenhoAmazon(janela, atribuicoes, registrar, coletarNaoAtribuida, marcarColeta);
  } catch (e) {
    console.warn('[desempenho] Amazon falhou:', e.message);
  }
  try {
    mudou += await desempenhoAwin(janela, atribuicoes, registrar);
  } catch (e) {
    console.warn('[desempenho] Awin falhou:', e.message);
  }
  try {
    mudou += await desempenhoMl(janela, atribuicoes, registrar, coletarNaoAtribuida, marcarColeta);
  } catch (e) {
    console.warn('[desempenho] Mercado Livre falhou:', e.message);
  }

  // Arquivo proprio: e uma leitura de mercado, nao desempenho dos disparos —
  // misturar no ranking distorceria comissaoPorDisparo e conversao.
  if (naoAtribuidas.size) {
    const itens = [...naoAtribuidas.values()].sort((a, b) => b.comissao - a.comissao);

    // Loja que nao respondeu mantem a foto anterior, marcada como defasada: o
    // painel prefere um numero de ontem identificado como tal a um buraco.
    try {
      const { dados: anterior } = await lerJson(ARQ_DESCOBERTAS, null);
      const desdeQuando = anterior?.atualizadoEm || null;
      const preservados = (anterior?.itens || [])
        .filter((x) => x.loja && !lojasColetadas.has(x.loja))
        .map((x) => ({ ...x, defasado: true, coletadoEm: x.coletadoEm || desdeQuando }));
      if (preservados.length) {
        const lojas = [...new Set(preservados.map((x) => x.loja))];
        console.log(`[desempenho] descobertas: ${lojas.join(', ')} nao respondeu(ram) — `
          + `${preservados.length} item(ns) preservado(s) da rodada anterior`);
        itens.push(...preservados);
        itens.sort((a, b) => b.comissao - a.comissao);
      }
    } catch (e) {
      console.warn('[desempenho] descobertas: preservacao da rodada anterior falhou —', e.message);
    }

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
        if (x.defasado) { l.defasado = true; l.coletadoEm = x.coletadoEm || l.coletadoEm; }
      }
      await gravarJson(ARQ_DESCOBERTAS, {
        atualizadoEm: new Date().toISOString(),
        janela: { de: janela[0], ate: janela[janela.length - 1] },
        totais, porLoja, itens,
      }, `chore: vendas descobertas (${itens.length} produtos)`);
      console.log(`[desempenho] descobertas: ${itens.length} produtos `
        + `(R$ ${totais.comissao} em comissao) — ${Object.keys(porLoja).join(', ')}`);

      // Enriquecimento do ledger de EPC. Roda AQUI, depois das descobertas
      // existirem nesta rodada — dentro de acumularEpcAmazon o arquivo ainda
      // seria o da rodada anterior.
      try { await cruzarEpcComDescobertas(itens); }
      catch (e) { console.warn('[desempenho] cruzamento EPC x descobertas falhou:', e.message); }
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
