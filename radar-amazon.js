// ═══════════════════════════════════════════════════════════════════════════
// radar-amazon.js — Radar de ofertas de marketplace para o Gestão TSP
//
// Fluxo: grupo-fonte (WhatsApp) -> link Amazon -> ASIN -> Creators API
//        -> link com o SEU partnerTag -> mensagem no formato da aba Oferta
//        -> filaPendentes com tipoConteudo 'oferta_amazon'
//
// A Creators API substituiu a PA-API 5.0 (descontinuada em 15/05/2026).
// Autenticacao: OAuth client_credentials via Login with Amazon.
// Brasil fica na regiao NA -> token endpoint api.amazon.com.
//
// Requisitos no Railway:
//   AMZ_CLIENT_ID      credencial da Creators API
//   AMZ_CLIENT_SECRET  segredo da Creators API
//   AMZ_PARTNER_TAG    ex: tudosobrepromos-20
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';

const SESSAO_DIR      = './sessao';
const RADAR_CFG_PATH  = SESSAO_DIR + '/radar_config.json';
const RADAR_DEDUP_PATH = SESSAO_DIR + '/radar_vistos.json';

const LINK_CONVITE_OFERTAS = 'https://chat.whatsapp.com/Ia5ZTqeTJdXHG5OT9LUwz8';

// ── CONFIG ────────────────────────────────────────────────────────────────

const CFG_PADRAO = {
  // jid -> 'fonte' | 'destino'. Gravado pela aba Grupos do painel.
  papeis: {},
  ativo: true,
  descontoMinimo: 5,      // % — abaixo disso descarta, salvo se for deal relampago
  dedupHoras: 24,
  partnerTag: process.env.AMZ_PARTNER_TAG || '',
  gatilhoPadrao: '',      // texto opcional no topo da mensagem
};

let _cfg = { ...CFG_PADRAO };

export function carregarRadarConfig() {
  try {
    if (existsSync(RADAR_CFG_PATH)) {
      _cfg = { ...CFG_PADRAO, ...JSON.parse(readFileSync(RADAR_CFG_PATH, 'utf-8')) };
      const f = radarFontes().length, d = radarDestinos().length;
      console.log(`[MKT] Config carregada — ${f} grupo(s) fonte, ${d} destino.`);
    } else {
      console.log('[MKT] Sem config em disco, usando padrao.');
    }
  } catch (e) {
    console.log('[MKT] Erro ao carregar config:', e.message);
  }
  return _cfg;
}

export function radarConfig() { return _cfg; }

export function salvarRadarConfig(novo = {}) {
  _cfg = { ..._cfg, ...novo };
  if (novo.papeis) _cfg.papeis = novo.papeis;
  try {
    writeFileSync(RADAR_CFG_PATH, JSON.stringify(_cfg, null, 2), 'utf-8');
  } catch (e) {
    console.log('[MKT] Erro ao salvar config:', e.message);
  }
  return _cfg;
}

export function radarFontes() {
  return Object.keys(_cfg.papeis || {}).filter(j => _cfg.papeis[j] === 'fonte');
}
export function radarDestinos() {
  return Object.keys(_cfg.papeis || {}).filter(j => _cfg.papeis[j] === 'destino');
}
export function ehFonteRadar(jid) {
  return _cfg.ativo !== false && _cfg.papeis?.[jid] === 'fonte';
}

// ── DEDUPLICACAO ──────────────────────────────────────────────────────────
// Persiste em disco para nao repostar o mesmo ASIN depois de um restart.

let _vistos = {};   // asin -> { preco, ts }

function carregarVistos() {
  try {
    if (existsSync(RADAR_DEDUP_PATH)) _vistos = JSON.parse(readFileSync(RADAR_DEDUP_PATH, 'utf-8'));
  } catch (e) { _vistos = {}; }
}
function salvarVistos() {
  try {
    const limite = Date.now() - (_cfg.dedupHoras || 24) * 3600e3;
    for (const k of Object.keys(_vistos)) if (_vistos[k].ts < limite) delete _vistos[k];
    writeFileSync(RADAR_DEDUP_PATH, JSON.stringify(_vistos), 'utf-8');
  } catch (e) {}
}
carregarVistos();

function jaDivulgado(p) {
  const ant = _vistos[p.asin];
  if (!ant) return false;
  if (Date.now() - ant.ts > (_cfg.dedupHoras || 24) * 3600e3) return false;
  // Se caiu mais de 5% desde a ultima vez, vale repostar
  if (ant.preco && p.preco && p.preco < ant.preco * 0.95) return false;
  return true;
}
function registrarVisto(p) {
  _vistos[p.asin] = { preco: p.preco, ts: Date.now() };
  salvarVistos();
}

// ── EXTRACAO DE ASIN ──────────────────────────────────────────────────────

const PADROES_ASIN = [
  /\/dp\/(?:product\/)?([A-Z0-9]{10})/i,
  /\/gp\/(?:product|aw\/d|offer-listing)\/([A-Z0-9]{10})/i,
  /\/product\/([A-Z0-9]{10})/i,
  /[?&]asin=([A-Z0-9]{10})/i,
];

const REGEX_URL_AMAZON = /https?:\/\/(?:[\w-]+\.)*(?:amazon\.com\.br|amzn\.to|a\.co|amzn\.eu)\/\S+/gi;

function asinDeUrl(url) {
  for (const re of PADROES_ASIN) {
    const m = url.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// Encurtadores (amzn.to, a.co) nao carregam o ASIN. Segue os redirects
// manualmente. Usa Range para nao baixar a pagina inteira — a Amazon costuma
// ignorar HEAD nesses shortlinks.
async function resolverEncurtador(url, tentativas = 5) {
  let atual = url;
  for (let i = 0; i < tentativas; i++) {
    const res = await fetch(atual, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Range': 'bytes=0-0',
      },
      signal: AbortSignal.timeout(8000),
    });
    const loc = res.headers.get('location');
    if (!loc) return res.url || atual;
    atual = new URL(loc, atual).href;
    if (asinDeUrl(atual)) return atual;
  }
  return atual;
}

export async function extrairAsins(texto) {
  if (!texto) return [];
  const urls = [...new Set(texto.match(REGEX_URL_AMAZON) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  const asins = new Set();
  for (const url of urls) {
    let asin = asinDeUrl(url);
    if (!asin) {
      try { asin = asinDeUrl(await resolverEncurtador(url)); }
      catch (e) { console.warn('[MKT] Falha ao resolver', url, '-', e.message); }
    }
    if (asin) asins.add(asin);
  }
  return [...asins];
}

// ── CREATORS API ──────────────────────────────────────────────────────────

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';  // regiao NA (BR)
const API_BASE       = 'https://creatorsapi.amazon';
const MARKETPLACE    = 'www.amazon.com.br';

let _token = { valor: null, expiraEm: 0 };

async function getToken() {
  if (_token.valor && Date.now() < _token.expiraEm) return _token.valor;
  if (!process.env.AMZ_CLIENT_ID || !process.env.AMZ_CLIENT_SECRET) {
    throw new Error('AMZ_CLIENT_ID / AMZ_CLIENT_SECRET nao configurados.');
  }
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.AMZ_CLIENT_ID,
      client_secret: process.env.AMZ_CLIENT_SECRET,
      scope: 'creatorsapi::default',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('Token Creators API falhou: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  _token = { valor: data.access_token, expiraEm: Date.now() + (data.expires_in - 300) * 1000 };
  return _token.valor;
}

const RECURSOS = [
  'itemInfo.title',
  'itemInfo.byLineInfo',
  'images.primary.large',
  'offersV2.listings.price',
  'offersV2.listings.availability',
  'offersV2.listings.condition',
  'offersV2.listings.dealDetails',
  'offersV2.listings.isBuyBoxWinner',
  'offersV2.listings.merchantInfo',
  'customerReviews.starRating',
  'customerReviews.count',
];

// GetItems aceita ate 10 ASINs por chamada.
export async function buscarProdutos(asins) {
  if (!asins.length) return [];
  const token = await getToken();
  const partnerTag = _cfg.partnerTag || process.env.AMZ_PARTNER_TAG;
  if (!partnerTag) throw new Error('partnerTag nao configurado.');

  const lotes = [];
  for (let i = 0; i < asins.length; i += 10) lotes.push(asins.slice(i, i + 10));

  const itens = [];
  for (const lote of lotes) {
    const res = await fetch(API_BASE + '/catalog/v1/getItems', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'x-marketplace': MARKETPLACE,
      },
      body: JSON.stringify({
        itemIds: lote,
        itemIdType: 'ASIN',
        marketplace: MARKETPLACE,
        partnerTag,
        partnerType: 'Associates',
        resources: RECURSOS,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error('[MKT] getItems', res.status, (await res.text()).slice(0, 300));
      continue;
    }
    const data = await res.json();
    itens.push(...(data?.itemsResult?.items || []));
    if (lotes.length > 1) await new Promise(r => setTimeout(r, 1100));
  }
  return itens;
}

// ── NORMALIZACAO ──────────────────────────────────────────────────────────

// A Amazon pode devolver mais de um listing para o mesmo ASIN (ex.: um Prime
// Exclusive e um aberto) e a ordem NAO e garantida. Anunciar o preco Prime como
// se fosse geral gera reclamacao no grupo, entao prioriza o buy box.
function escolherListing(item) {
  const listings = item?.offersV2?.listings || [];
  if (!listings.length) return null;
  return listings.find(l => l.isBuyBoxWinner) || listings[0];
}

export function normalizar(item) {
  const l = escolherListing(item);
  const preco = l?.price?.money;
  const de    = l?.price?.savingBasis?.money;
  const desconto = (de?.amount && preco?.amount)
    ? Math.round((1 - preco.amount / de.amount) * 100)
    : 0;

  return {
    asin: item.asin,
    titulo: item?.itemInfo?.title?.displayValue || '',
    marca: item?.itemInfo?.byLineInfo?.brand?.displayValue || '',
    imagemUrl: item?.images?.primary?.large?.url || null,
    link: item.detailPageURL,          // ja vem com o partnerTag aplicado
    preco: preco?.amount ?? null,
    precoTexto: preco?.displayAmount || null,
    precoDe: de?.amount ?? null,
    precoDeTexto: de?.displayAmount || null,
    desconto,
    disponivel: l?.availability?.type === 'IN_STOCK',
    vendedor: l?.merchantInfo?.name || null,
    ehDeal: Boolean(l?.dealDetails),
    dealTermina: l?.dealDetails?.endTime || null,
    nota: item?.customerReviews?.starRating?.value ?? null,
    avaliacoes: item?.customerReviews?.count ?? null,
    loja: 'Amazon',
  };
}

// ── FORMATACAO ────────────────────────────────────────────────────────────
// Segue exatamente o formato da aba Oferta do gerador, para a mensagem do robo
// ser indistinguivel da que voce escreve na mao.

function brl(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function encurtarTitulo(t, max = 80) {
  if (!t || t.length <= max) return t || '';
  const corte = t.lastIndexOf(' ', max);
  return t.slice(0, corte > 40 ? corte : max) + '...';
}

export function formatarOfertaAmazon(p, opcoes = {}) {
  const gatilho = opcoes.gatilho ?? _cfg.gatilhoPadrao ?? '';
  let msg = '';

  if (gatilho) msg += '`🚨 ' + gatilho + '`\n\n';

  msg += '*' + encurtarTitulo(p.titulo) + '*\n\n';

  if (p.precoDe && p.desconto > 0) {
    msg += 'De: ~R$ ' + brl(p.precoDe) + '~\nPor: R$ ' + brl(p.preco) + '\n\n';
  } else {
    msg += 'Por: R$ ' + brl(p.preco) + '\n\n';
  }

  const importantes = [];
  if (p.desconto >= 40) importantes.push(p.desconto + '% de desconto');
  if (p.dealTermina) {
    const fim = new Date(p.dealTermina).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
    importantes.push('Oferta relâmpago, termina em ' + fim);
  }
  if (importantes.length) msg += '⚠️ *IMPORTANTE* ' + importantes.join('. ') + '\n\n';

  msg += '🛒 *LOJA* AMAZON\n\n🔗 *LINK* ' + p.link + '\n\n';
  msg += '`Convide seus amigos para entrar aqui no grupo:  ' + LINK_CONVITE_OFERTAS + '`';

  return msg;
}

// ── PIPELINE ──────────────────────────────────────────────────────────────

/**
 * Recebe o texto bruto de uma mensagem e devolve as ofertas prontas.
 * A API e a fonte da verdade: preco, estoque e desconto vem dela, nunca do
 * texto do grupo de origem — e o que evita repassar oferta que ja morreu.
 *
 * @param {string} texto
 * @param {object} opcoes  { ignorarDedup: bool, gatilho: string }
 * @returns {Promise<Array<{ produto, mensagem, descartadoPor? }>>}
 */
export async function processarTextoAmazon(texto, opcoes = {}) {
  const asins = await extrairAsins(texto);
  if (!asins.length) return [];

  const itens = await buscarProdutos(asins);
  const saida = [];

  for (const item of itens) {
    const p = normalizar(item);

    if (!p.preco)      { saida.push({ produto: p, descartadoPor: 'sem preço disponível' }); continue; }
    if (!p.disponivel) { saida.push({ produto: p, descartadoPor: 'produto esgotado' }); continue; }
    if (p.desconto < (_cfg.descontoMinimo ?? 5) && !p.ehDeal) {
      saida.push({ produto: p, descartadoPor: 'desconto de ' + p.desconto + '% abaixo do mínimo' });
      continue;
    }
    if (!opcoes.ignorarDedup && jaDivulgado(p)) {
      saida.push({ produto: p, descartadoPor: 'já divulgado nas últimas ' + (_cfg.dedupHoras || 24) + 'h' });
      continue;
    }

    saida.push({ produto: p, mensagem: formatarOfertaAmazon(p, opcoes) });
    if (!opcoes.ignorarDedup) registrarVisto(p);
  }
  return saida;
}

carregarRadarConfig();
