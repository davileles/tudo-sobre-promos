// coletar-comissoes.js — TSP
//
// Coleta diária de cliques, vendas e comissão nas três plataformas de afiliado
// (Amazon Associados, Mercado Livre Afiliados, Shopee) e grava em
// cdv-tsp-dados/tsp/comissoes-afiliados.json.
//
// Substitui o preenchimento manual da aba "Comissionamento" da planilha.
//
// ── Como cada plataforma é lida ────────────────────────────────────────────
//
// AMAZON  A página /p/reporting/earnings é renderizada no servidor e traz um
//         JSON diário embutido no HTML dos últimos 7 dias. As rotas XHR
//         /reporting/* respondem 401 mesmo com sessão válida (têm um header
//         que só o bundle deles gera), então NÃO tente migrar para elas.
//         vendas = revenue - returned_revenue ; comissão = total_earnings_with_hva
//
// ML      API REST limpa, /affiliate-program/api/dashboard/general. Um dia por
//         requisição. Não precisa de CSRF apesar de o navegador mandar.
//
// SHOPEE  Dividida em duas fontes:
//         · cliques  → /api/v1/click_report/list (cookie). Com page_size=1 a
//           resposta traz total_count sem nenhum registro.
//         · vendas e comissão → Open API GraphQL oficial (AppID + assinatura
//           SHA256, sem cookie). A Open API NÃO expõe cliques — por isso a
//           divisão. Agrupa em UTC-3, confirmado empiricamente.
//
// ── Foto vs. revisão ──────────────────────────────────────────────────────
//
// `cliques`/`vendas`/`comissao` são a FOTO do dia: gravados uma vez, quando a
// data entra no arquivo, e nunca mais alterados. É o mesmo critério dos ~5
// meses de histórico importados da planilha, então a série continua comparável.
//
// `vendasRev`/`comissaoRev` são reprocessados a cada rodada dentro de uma
// janela móvel. Amazon não revisa nada. ML e Shopee revisam nos dois sentidos
// (pedido cancelado ou aprovado depois). Quem quiser o número fechado usa os
// campos Rev; quem quiser a série histórica usa a foto.

const REPO_DADOS = process.env.REPO_DADOS || 'davileles/cdv-tsp-dados';
const ARQUIVO = process.env.ARQUIVO_COMISSOES || 'tsp/comissoes-afiliados.json';
const GH_TOKEN = process.env.GH_TOKEN_DADOS;
const PROXY_URL = process.env.CDV_PROXY_URL || 'https://cdv-proxy-production.up.railway.app';

const ATIVO = process.env.COLETA_COMISSOES !== 'false';
const JANELA_REV = Number(process.env.JANELA_REV || 15);

const AMAZON_COOKIE = process.env.AMAZON_COOKIE;
const ML_COOKIE = process.env.ML_COOKIE;
const SHOPEE_COOKIE = process.env.SHOPEE_COOKIE;
const SHOPEE_APP_ID = process.env.SHOPEE_APP_ID;
const SHOPEE_SECRET = process.env.SHOPEE_SECRET;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const crypto = require('crypto');

// ── utilidades ────────────────────────────────────────────────────────────

// AbortSignal.timeout() não é confiável em toda versão; AbortController é.
async function req(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// O Brasil não tem mais horário de verão desde 2019, então -03:00 é fixo.
const TZ = '-03:00';
const epoch = (data, hora) => Math.floor(new Date(`${data}T${hora}${TZ}`).getTime() / 1000);
const inicioDoDia = (data) => epoch(data, '00:00:00');
const fimDoDia = (data) => epoch(data, '23:59:59');

function hojeSP() {
  const agora = new Date();
  return new Date(agora.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function diasAtras(dataISO, n) {
  const d = new Date(`${dataISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

async function alertar(titulo, linhas) {
  const mensagem = [
    `⚠️ *${titulo}*`, '', ...linhas.filter(Boolean), '',
    `_Coletor de comissões TSP — ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_`,
  ].join('\n');
  try {
    const r = await req(`${PROXY_URL}/alertas/operador`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensagem }),
    }, 25000);
    console.log(r.ok ? `[alerta] enviado: ${titulo}` : `[alerta] falhou: status ${r.status}`);
  } catch (e) {
    console.warn(`[alerta] falhou: ${e.message}`);
  }
}

// ── Amazon ────────────────────────────────────────────────────────────────

async function coletarAmazon() {
  if (!AMAZON_COOKIE) throw new Error('AMAZON_COOKIE ausente');

  const r = await req('https://associados.amazon.com.br/p/reporting/earnings', {
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9', cookie: AMAZON_COOKIE },
    redirect: 'manual',
  });

  // 302 = cookie expirou e caiu no redirect de login.
  if (r.status >= 300 && r.status < 400) throw new Error('sessão expirada (302) — renove AMAZON_COOKIE');
  if (!r.ok) throw new Error(`status ${r.status}`);

  const html = (await r.text())
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c));

  const blocos = html.match(/\{[^{}]*"day":"\d{4}-\d{2}-\d{2}"[^{}]*\}/g) || [];
  if (!blocos.length) throw new Error('HTML veio sem a série diária — layout pode ter mudado');

  const out = {};
  for (const b of blocos) {
    let o;
    try { o = JSON.parse(b); } catch { continue; }
    if (!o.day || o.clicks === undefined) continue;
    out[o.day] = {
      cliques: parseInt(o.clicks, 10),
      vendas: num(parseFloat(o.revenue || 0) - parseFloat(o.returned_revenue || 0)),
      comissao: num(o.total_earnings_with_hva),
    };
  }
  if (!Object.keys(out).length) throw new Error('série diária veio vazia');
  return out;
}

// ── Mercado Livre ─────────────────────────────────────────────────────────

async function mlDia(data) {
  const prox = diasAtras(data, -1);
  const range = `${data}T00:00:00.000${TZ}--${prox}T00:00:00.000${TZ}`;
  const url = 'https://www.mercadolivre.com.br/affiliate-program/api/dashboard/general'
    + `?filter_time_range=${encodeURIComponent(range)}&metric_tab=general&type=GENERAL&page=1`;

  const r = await req(url, { headers: { 'user-agent': UA, accept: 'application/json', cookie: ML_COOKIE } });
  if (r.status === 401 || r.status === 403) throw new Error('sessão expirada — renove ML_COOKIE');
  if (!r.ok) throw new Error(`status ${r.status}`);

  const j = await r.json();
  const met = Object.fromEntries((j.data || []).map((x) => [x.id, x.current_amount]));
  const com = Object.fromEntries((j.commissions || []).map((x) => [x.id, x.current_amount]));
  if (met.clicks === undefined) throw new Error('resposta sem métricas — formato pode ter mudado');

  return { cliques: parseInt(met.clicks, 10), vendas: num(met.sales), comissao: num(com.summary) };
}

async function coletarML(datas) {
  if (!ML_COOKIE) throw new Error('ML_COOKIE ausente');
  const out = {};
  for (const d of datas) {
    out[d] = await mlDia(d);
    await new Promise((res) => setTimeout(res, 400)); // não martelar a API
  }
  return out;
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

async function shopeeCliques(data) {
  const url = 'https://affiliate.shopee.com.br/api/v1/click_report/list'
    + `?click_time_s=${inicioDoDia(data)}&click_time_e=${fimDoDia(data)}&page_num=1&page_size=1`;

  const r = await req(url, {
    headers: {
      'user-agent': UA, accept: '*/*',
      referer: 'https://affiliate.shopee.com.br/report/click_report',
      cookie: SHOPEE_COOKIE,
    },
  });
  if (!r.ok) throw new Error(`cliques: status ${r.status}`);

  const j = await r.json();
  if (j.code !== 0) throw new Error(`cliques: code ${j.code} — sessão pode ter expirado (renove SHOPEE_COOKIE)`);
  return j.data?.total_count ?? null;
}

async function shopeeVendas(data) {
  let scrollId = null, comissao = 0, vendas = 0, guard = 0;
  do {
    const sc = scrollId ? `, scrollId:"${scrollId}"` : '';
    const d = await shopeeGql(`{ conversionReport(purchaseTimeStart:${inicioDoDia(data)}, `
      + `purchaseTimeEnd:${fimDoDia(data)}, limit:500${sc}){ `
      + 'nodes { totalCommission orders { items { actualAmount } } } '
      + 'pageInfo { hasNextPage scrollId } } }');

    const rep = d?.conversionReport;
    if (!rep) throw new Error('conversionReport vazio');
    for (const n of rep.nodes || []) {
      comissao += parseFloat(n.totalCommission || 0);
      for (const o of n.orders || []) for (const it of o.items || []) vendas += parseFloat(it.actualAmount || 0);
    }
    scrollId = rep.pageInfo?.hasNextPage ? rep.pageInfo.scrollId : null;
  } while (scrollId && ++guard < 30);

  return { vendas: num(vendas), comissao: num(comissao) };
}

async function coletarShopee(datas) {
  if (!SHOPEE_COOKIE) throw new Error('SHOPEE_COOKIE ausente');
  if (!SHOPEE_APP_ID || !SHOPEE_SECRET) throw new Error('SHOPEE_APP_ID/SHOPEE_SECRET ausentes');

  const out = {};
  for (const d of datas) {
    const [cliques, vc] = await Promise.all([shopeeCliques(d), shopeeVendas(d)]);
    // O relatório de cliques só consolida o dia anterior às 17h30; antes disso
    // devolve 0. Zero com venda no mesmo dia é impossível — é dado não
    // publicado ainda, e gravar como 0 congelaria um número errado. Vira null
    // e a próxima rodada preenche.
    const aindaNaoPublicado = cliques === 0 && (vc.vendas || 0) > 0;
    out[d] = { cliques: aindaNaoPublicado ? null : cliques, ...vc };
    await new Promise((res) => setTimeout(res, 400));
  }
  return out;
}

// ── persistência ──────────────────────────────────────────────────────────

async function lerArquivo() {
  const r = await req(`https://api.github.com/repos/${REPO_DADOS}/contents/${ARQUIVO}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`leitura do arquivo: status ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, dados: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}

async function gravarArquivo(dados, mensagem) {
  // SHA sempre buscado imediatamente antes do PUT: outros jobs escrevem no
  // mesmo repo e um SHA de 30s atrás já pode estar velho.
  const atual = await lerArquivo();
  const r = await req(`https://api.github.com/repos/${REPO_DADOS}/contents/${ARQUIVO}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: mensagem,
      sha: atual.sha,
      content: Buffer.from(JSON.stringify(dados, null, 1), 'utf8').toString('base64'),
    }),
  }, 60000);
  if (!r.ok) throw new Error(`gravação: status ${r.status} — ${(await r.text()).slice(0, 200)}`);
}

// Diferenças abaixo de 5 centavos são ruído de arredondamento do histórico
// importado da planilha (a Shopee exibia "1,3mil" e virou 1300), não revisão
// de verdade. Sem esse piso o arquivo enche de vendasRev: 517.12 contra
// vendas: 517.1, que não informa nada.
const PISO_REVISAO = 0.05;

// Comissão que ainda não entrou na plataforma na hora da coleta aparece como
// zero — acontece nas três, não só na Shopee. Congelar esse zero como foto
// perderia o dia inteiro. Enquanto o registro estiver zerado E dentro da
// janela, cada rodada refaz a foto do zero. Quando o número aparece, congela.
// Se o dia foi mesmo zero, ele sai da janela zerado e fica correto.
const zerado = (v) => !v || ((v.vendas || 0) === 0 && (v.comissao || 0) === 0);

// Foto grava uma vez e congela; Rev acompanha as revisões da plataforma.
// Lacuna (dia sem dado nenhum) é preenchida em qualquer ponto da janela — foi
// o caso da Shopee em 09/08, que não existia quando o histórico foi importado.
function aplicar(dias, plataforma, data, valores, ehFoto) {
  if (!valores) return null;
  dias[data] = dias[data] || {};
  const atual = dias[data][plataforma];

  if (!atual) {
    if (valores.vendas == null && valores.comissao == null && valores.cliques == null) return null;
    dias[data][plataforma] = valores;
    return ehFoto ? 'foto' : 'lacuna';
  }

  // Foto zerada ainda não é foto: reescreve até a plataforma liberar o número.
  if (zerado(atual) && !zerado(valores)) {
    dias[data][plataforma] = valores;
    return 'refeita';
  }
  if (zerado(atual)) {
    if (atual.cliques == null && valores.cliques != null) { atual.cliques = valores.cliques; return 'revisao'; }
    return null;
  }

  let mudou = false;
  // Coleta zerada em cima de foto boa é falha transitória da plataforma, não
  // revisão. Gravar vendasRev: 0 destruiria o dado. Revisão real para zero
  // (tudo cancelado) existe, mas é rara demais para valer o risco.
  if (!zerado(valores)) {
    for (const [campo, chave] of [['vendas', 'vendasRev'], ['comissao', 'comissaoRev']]) {
      if (valores[campo] == null) continue;
      const ref = atual[chave] ?? atual[campo];
      if (Math.abs(ref - valores[campo]) > PISO_REVISAO) { atual[chave] = valores[campo]; mudou = true; }
    }
  }
  // Cliques da Shopee só saem às 17h30; completa quando chegarem.
  if (atual.cliques == null && valores.cliques != null) { atual.cliques = valores.cliques; mudou = true; }
  return mudou ? 'revisao' : null;
}

// ── principal ─────────────────────────────────────────────────────────────

async function main() {
  if (!ATIVO) return console.log('COLETA_COMISSOES=false — coleta suprimida');
  if (!GH_TOKEN) throw new Error('GH_TOKEN_DADOS ausente');

  const ontem = diasAtras(hojeSP(), 1);
  const janela = Array.from({ length: JANELA_REV }, (_, i) => diasAtras(ontem, i)).reverse();
  console.log(`[coleta] foto de ${ontem} · janela de revisão ${janela[0]} → ${ontem}`);

  const falhas = [];
  const resultados = await Promise.all([
    coletarAmazon().catch((e) => { falhas.push(['Amazon', e.message]); return null; }),
    coletarML(janela).catch((e) => { falhas.push(['Mercado Livre', e.message]); return null; }),
    coletarShopee(janela).catch((e) => { falhas.push(['Shopee', e.message]); return null; }),
  ]);

  const porPlataforma = { amazon: resultados[0], ml: resultados[1], shopee: resultados[2] };

  const { dados } = await lerArquivo();
  dados.dias = dados.dias || {};

  const resumo = { foto: 0, lacuna: 0, refeita: 0, revisao: 0 };
  for (const [plataforma, coletado] of Object.entries(porPlataforma)) {
    if (!coletado) continue;
    for (const [data, valores] of Object.entries(coletado)) {
      const efeito = aplicar(dados.dias, plataforma, data, valores, data === ontem);
      if (efeito) resumo[efeito]++;
    }
  }

  dados.dias = Object.fromEntries(Object.keys(dados.dias).sort().map((k) => [k, dados.dias[k]]));
  dados.atualizadoEm = new Date().toISOString();

  if (resumo.foto || resumo.lacuna || resumo.refeita || resumo.revisao) {
    const desc = `${resumo.foto} fotos, ${resumo.lacuna} lacunas, `
      + `${resumo.refeita} refeitas, ${resumo.revisao} revisões`;
    await gravarArquivo(dados, `chore: comissões de afiliados ${ontem} (${desc})`);
    console.log(`[coleta] gravado — ${desc}`);
  } else {
    console.log('[coleta] nada mudou, arquivo não tocado');
  }

  for (const [plataforma] of falhas) {
    const d = dados.dias[ontem]?.[plataforma === 'Amazon' ? 'amazon' : plataforma === 'Shopee' ? 'shopee' : 'ml'];
    if (!d) console.warn(`[coleta] ${ontem} ficou sem dado de ${plataforma}`);
  }

  if (falhas.length) {
    await alertar('Coleta de comissões falhou', [
      `Data alvo: *${ontem}*`, '',
      ...falhas.map(([p, m]) => `• *${p}*: ${m}`), '',
      falhas.some(([, m]) => /sessão expirada|SHOPEE_COOKIE|code /.test(m))
        ? '_Cookie expirado. Recapture no navegador e atualize o secret._' : '',
    ]);
    process.exitCode = 1;
  }
}

main().catch(async (e) => {
  console.error('[coleta] erro fatal:', e.message);
  await alertar('Coleta de comissões abortou', [e.message]);
  process.exit(1);
});
