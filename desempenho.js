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
const GH_TOKEN = process.env.GH_TOKEN_DADOS;

const SHOPEE_COOKIE = process.env.SHOPEE_COOKIE;
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;

const AMAZON_COOKIE = process.env.AMAZON_COOKIE;

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
  // SHA sempre relido imediatamente antes do PUT — o baileys escreve no mesmo
  // repo e um SHA de segundos atrás já pode estar velho.
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
  if (!r.ok) throw new Error(`gravação de ${caminho}: status ${r.status} — ${(await r.text()).slice(0, 200)}`);
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

  const mTok = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="csrf-token"/);
  if (!mTok) throw new Error('meta csrf-token não encontrado — layout da página mudou');

  const mPs = html.match(/id="pageState"[^>]*data-page-state="([^"]*)"/)
    || html.match(/data-page-state="([^"]*)"[^>]*id="pageState"/);
  if (!mPs) throw new Error('#pageState não encontrado — layout da página mudou');

  let ps;
  try {
    ps = JSON.parse(mPs[1]
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&'));
  } catch { throw new Error('data-page-state não parseou como JSON — layout mudou'); }
  if (!ps.associateIdentityToken) throw new Error('associateIdentityToken ausente no pageState');

  return {
    storeId: ps.storeId,
    headers: {
      'user-agent': UA, cookie: AMAZON_COOKIE, accept: 'application/json',
      'x-csrf-token': mTok[1],
      authorization: 'Bearer ' + ps.associateIdentityToken,
      marketplaceid: ps.marketplaceId || '', locale: ps.locale || 'pt_BR',
      storeid: ps.storeId || '', customerid: ps.customerId || '',
      programid: ps.programId || '',
      roles: Array.isArray(ps.roles) ? ps.roles.join(',') : String(ps.roles ?? ''),
      language: ps.language || 'pt_BR', 'x-requested-with': 'XMLHttpRequest',
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
  const r = await req('https://associados.amazon.com.br/reporting/table?' + qs.toString(), {
    headers: ctx.headers,
  });
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

async function desempenhoAmazon(janela, atribuicoes, registrar) {
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
  const porRef = new Map();
  for (const a of atribuicoes) {
    if (!a.ref || String(a.loja || '').toLowerCase() === 'amazon') continue;
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

  // Cada loja é isolada: falha em uma não derruba a outra nem a coleta principal.
  let mudou = 0;
  try {
    mudou += await desempenhoShopee(janela, inicioDoDia, fimDoDia, atribuicoes, registrar);
  } catch (e) {
    console.warn('[desempenho] Shopee falhou:', e.message);
  }
  try {
    mudou += await desempenhoAmazon(janela, atribuicoes, registrar);
  } catch (e) {
    console.warn('[desempenho] Amazon falhou:', e.message);
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
