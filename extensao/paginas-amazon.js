// ── Captura Tica — leitura de página de produto da Amazon ─────────────────────
// O servidor (baileys-server) baixa a página do produto da Amazon para ler o
// preço à vista e, desde 18/11/2026, os cupons do bloco
// "promoPriceBlockMessage" (ex.: "Só no app: 50% off… código REFORMA50",
// "Salve o cupom 40%: BF40"). Do IP do Railway a Amazon às vezes responde com
// a página intermediária de robô; daqui, com os cookies deste Chrome, a página
// vem inteira. Quando o servidor não consegue, ele pede a página AQUI: este
// módulo fica em long-poll em /amazon/pagina/proximo, busca a página por
// fetch() do service worker (SEM ABRIR ABA — testado em 18/11/2026: a Amazon
// responde a página completa a um fetch com cookies) e devolve em
// /amazon/pagina/resultado só os trechos que interessam (título, bloco de
// preço e bloco de cupons — ~80 KB em vez de ~1,5 MB).
//
// Servidor ainda sem a rota (versão antiga do baileys-server): /proximo
// responde 404. Isso NÃO é erro — a extensão só anota "servidor ainda sem
// leitura da Amazon" e volta a perguntar de AMZ_SEM_ROTA_MS em
// AMZ_SEM_ROTA_MS. Nada disso mexe na leitura do ML, nos cupons ou no
// relatório da Shopee.
//
// Usa a mesma configuração dos cupons (mlAuto: ligado, token, servidor).
// Carregado pelo background.js via importScripts(), depois de cupons-ml.js.
// Estado em chrome.storage.local.amzPaginas { em, texto, hoje, dia, semRotaAte }.

const AMZ_ALARME = 'tica-paginas-amazon';
const AMZ_ESPERA_S = 25;                    // quanto o servidor segura o long-poll
const AMZ_SEM_ROTA_MS = 10 * 60000;         // servidor sem a rota: pergunta de novo em 10 min
const AMZ_ESPACO_MS = [3000, 6000];         // pausa entre páginas
const AMZ_FETCH_MS = 25000;
let amzRodando = false;

const amzDormir = ms => new Promise(r => setTimeout(r, ms));
async function amzEstado() {
  const { amzPaginas } = await chrome.storage.local.get({ amzPaginas: null });
  return amzPaginas || {};
}
async function amzStatus(texto, extra) {
  const atual = await amzEstado();
  await chrome.storage.local.set({ amzPaginas: Object.assign({}, atual, extra || {}, { em: Date.now(), texto: String(texto).slice(0, 200) }) });
}

// Chamada ao servidor com o status HTTP à mão (mlChamar engole o 404).
async function amzChamar(caminho, corpo, limiteMs) {
  const cfg = await mlCfg();
  if (!cfg.token) throw new Error('token da extensão não configurado');
  const r = await fetch(cfg.servidor.replace(/\/$/, '') + caminho, {
    method: corpo ? 'POST' : 'GET',
    headers: { 'X-Extensao-Token': cfg.token, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(limiteMs || 20000),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}

// ── Trechos da página ────────────────────────────────────────────────────────
// Cada trecho começa um pouco antes do marcador e leva um pedaço generoso
// depois; o servidor lê com as mesmas regras que usa na página inteira.
const AMZ_TRECHOS = [
  ['id="productTitle"', 500, 4000],
  ['id="corePrice_feature_div"', 500, 60000],
  ['id="corePriceDisplay_desktop_feature_div"', 500, 60000],
  ['id="promoPriceBlockMessage_feature_div"', 500, 60000],
  ['id="couponBadgeRegularVpc"', 500, 10000],
  ['id="vpcButton"', 500, 10000],
];
function amzCortar(html) {
  const s = String(html || '');
  if (!s.includes('id="productTitle"')) {
    // Sem título = não é a página do produto (robô, captcha, 404). Vai o
    // começo, que é onde a página intermediária se identifica.
    return { cortado: false, html: s.slice(0, 20000), semProduto: true };
  }
  const partes = [];
  let ultimoFim = -1;
  for (const [marca, antes, depois] of AMZ_TRECHOS) {
    const i = s.indexOf(marca);
    if (i < 0) continue;
    const ini = Math.max(0, i - antes, ultimoFim);
    const fim = Math.min(s.length, i + depois);
    if (fim <= ini) continue;
    partes.push(s.slice(ini, fim));
    ultimoFim = Math.max(ultimoFim, fim);
  }
  return { cortado: true, html: partes.join('\n<!--tica-corte-->\n'), tamanhoOriginal: s.length };
}

async function amzBuscar(url) {
  const r = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(AMZ_FETCH_MS),
  });
  const html = await r.text();
  return { url: r.url || url, status: r.status, ...amzCortar(html) };
}

// ── Laço de long-poll ────────────────────────────────────────────────────────
async function amzLaco() {
  if (amzRodando) return;
  amzRodando = true;
  try {
    for (;;) {
      const cfg = await mlCfg();
      if (!cfg.ligado || !cfg.token) break;
      const est = await amzEstado();
      if (est.semRotaAte && Date.now() < est.semRotaAte) break;   // o alarme volta depois

      let r;
      try {
        r = await amzChamar('/amazon/pagina/proximo?espera=' + AMZ_ESPERA_S, null, (AMZ_ESPERA_S + 10) * 1000);
      } catch (e) {
        await amzStatus('Servidor: ' + e.message);
        await amzDormir(30000);
        continue;
      }
      if (r.status === 404) {
        await amzStatus('Servidor ainda sem a leitura da Amazon — nova tentativa em 10 min', { semRotaAte: Date.now() + AMZ_SEM_ROTA_MS });
        break;
      }
      if (r.status === 401) { await amzStatus('Token da extensão recusado pelo servidor'); await amzDormir(60000); continue; }
      if (est.semRotaAte) await amzStatus('Leitura da Amazon ligada no servidor', { semRotaAte: 0 });
      const d = r.d || {};
      if (!d.ok) { await amzStatus('Servidor: ' + (d.erro || 'sem resposta')); await amzDormir(30000); continue; }
      if (!d.pedido) { await amzDormir(300); continue; }

      const p = d.pedido;
      let resultado;
      try {
        const b = await amzBuscar(p.url);
        resultado = { id: p.id, url: b.url, status: b.status, html: b.html, cortado: b.cortado, semProduto: !!b.semProduto, tamanhoOriginal: b.tamanhoOriginal || null };
      } catch (e) {
        resultado = { id: p.id, url: p.url, status: 0, html: '', erro: e.message };
      }
      let v = null;
      try { v = (await amzChamar('/amazon/pagina/resultado', resultado, 30000)).d; }
      catch (e) { await amzStatus('Falha ao devolver a página: ' + e.message); }
      const atual = await amzEstado();
      const hoje = (atual.dia === new Date().toDateString() ? (atual.hoje || 0) : 0) + 1;
      const txt = resultado.erro ? 'Falhou: ' + resultado.erro
        : resultado.semProduto ? 'A Amazon não mostrou o produto (página intermediária)'
        : 'Página lida' + (v && v.cupons ? ' · ' + v.cupons + ' cupom(ns)' : '');
      await amzStatus(txt, { hoje, dia: new Date().toDateString() });
      await amzDormir(AMZ_ESPACO_MS[0] + Math.random() * (AMZ_ESPACO_MS[1] - AMZ_ESPACO_MS[0]));
    }
  } finally {
    amzRodando = false;
  }
}

// ── Alarme (vigia): religa o laço se o Chrome derrubou o service worker ──────
async function amzArmarAlarme() {
  const cfg = await mlCfg();
  const atual = await chrome.alarms.get(AMZ_ALARME);
  if (cfg.ligado && cfg.token) {
    if (!atual) await chrome.alarms.create(AMZ_ALARME, { delayInMinutes: 0.2, periodInMinutes: 1 });
    amzLaco().catch(e => amzStatus('Erro: ' + e.message));
  } else if (atual) {
    await chrome.alarms.clear(AMZ_ALARME);
  }
}
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== AMZ_ALARME) return;
  amzLaco().catch(e => amzStatus('Erro: ' + e.message));
});
chrome.runtime.onInstalled.addListener(() => { amzArmarAlarme(); });
chrome.runtime.onStartup.addListener(() => { amzArmarAlarme(); });
chrome.storage.onChanged.addListener((mud, area) => { if (area === 'local' && mud.mlAuto) amzArmarAlarme(); });

// Popup: estado da leitura da Amazon.
chrome.runtime.onMessage.addListener((msg, _r, responder) => {
  if (!msg || msg.tipo !== 'amazon-paginas') return false;
  (async () => {
    const ultimo = await amzEstado();
    let servidor = null;
    try { const r = await amzChamar('/amazon/pagina/estado', null, 8000); servidor = r.status === 404 ? { ok: false, semRota: true } : r.d; }
    catch (e) { servidor = { ok: false, erro: e.message }; }
    responder({ ultimo, rodando: amzRodando, servidor });
  })().catch(e => { try { responder({ ok: false, erro: e.message }); } catch (_) {} });
  return true;
});
