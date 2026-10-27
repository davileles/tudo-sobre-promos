// ── Captura Tica — leitura de página de produto do Mercado Livre ──────────────
// Desde 11/10/2026 a página pública de produto do ML responde ao IP do Railway
// com a tela "Seguridad" (/captcha/wall). O servidor (baileys-server) passou a
// pedir a página AQUI: este módulo fica em long-poll em /ml/pagina/proximo e,
// quando chega um pedido, faz um fetch() da página a partir do Chrome do
// operador — IP residencial, TLS de navegador, SEM cookie (credentials:
// 'omit', nada da sua conta vai junto) e SEM aba: nenhuma janela abre, nada
// muda na tela. O HTML volta em /ml/pagina/resultado e quem interpreta é o
// servidor. Usa a mesma configuração dos cupons (mlAuto: ligado, token,
// servidor): um interruptor só para as duas coisas.
//
// Carregado pelo background.js via importScripts(), depois de cupons-ml.js
// (usa mlCfg e mlChamar de lá). Estado em chrome.storage:
//   mlPaginas { em, texto, hoje }   — última linha de status (popup)

const PG_ALARME = 'tica-paginas-ml';
const PG_ESPERA_S = 25;                   // quanto o servidor segura o long-poll
const PG_FETCH_MS = 20000;                // prazo da busca da página
const PG_ESPACO_MS = [4000, 8000];        // pausa entre páginas, como uma pessoa navegando
let pgRodando = false;                    // laço de long-poll vivo NESTE service worker

const pgDormir = ms => new Promise(r => setTimeout(r, ms));
async function pgStatus(texto, extra) {
  const { mlPaginas } = await chrome.storage.local.get({ mlPaginas: null });
  await chrome.storage.local.set({ mlPaginas: Object.assign({}, mlPaginas, extra || {}, { em: Date.now(), texto: String(texto).slice(0, 200) }) });
}

// ── Busca de UMA página ──────────────────────────────────────────────────────
async function pgBuscar(url) {
  const r = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    signal: AbortSignal.timeout(PG_FETCH_MS),
  });
  const html = await r.text();
  return { url: r.url || url, status: r.status, html };
}

// ── Laço de long-poll ────────────────────────────────────────────────────────
async function pgLaco() {
  if (pgRodando) return;
  pgRodando = true;
  try {
    for (;;) {
      const cfg = await mlCfg();
      if (!cfg.ligado || !cfg.token) break;
      let r;
      try {
        r = await mlChamar('/ml/pagina/proximo?espera=' + PG_ESPERA_S, null, (PG_ESPERA_S + 10) * 1000);
      } catch (e) {
        await pgStatus('Servidor: ' + e.message);
        await pgDormir(30000);
        continue;
      }
      if (!r || !r.ok) { await pgStatus('Servidor: ' + (r && r.erro || 'sem resposta')); await pgDormir(30000); continue; }
      if (!r.pedido) { await pgDormir(300); continue; }

      const p = r.pedido;
      let resultado;
      try {
        const b = await pgBuscar(p.url);
        resultado = { id: p.id, url: b.url, status: b.status, html: b.html };
      } catch (e) {
        resultado = { id: p.id, url: p.url, status: 0, html: '', erro: e.message };
      }
      let v = null;
      try { v = await mlChamar('/ml/pagina/resultado', resultado, 30000); }
      catch (e) { await pgStatus('Falha ao devolver a página: ' + e.message); }
      const { mlPaginas } = await chrome.storage.local.get({ mlPaginas: null });
      const hoje = (mlPaginas && mlPaginas.dia === new Date().toDateString() ? mlPaginas.hoje : 0) + 1;
      await pgStatus((resultado.erro ? 'Falhou: ' + resultado.erro : (v && v.veredito === 'bloqueada' ? 'Página veio com a tela de segurança' : 'Página lida'))
        + ' · ' + (p.motivo === 'sonda' ? 'sonda' : 'leitura'), { hoje, dia: new Date().toDateString() });
      await pgDormir(PG_ESPACO_MS[0] + Math.random() * (PG_ESPACO_MS[1] - PG_ESPACO_MS[0]));
    }
  } finally {
    pgRodando = false;
  }
}

// ── Alarme (vigia): religa o laço se o Chrome derrubou o service worker ──────
async function pgArmarAlarme() {
  const cfg = await mlCfg();
  const atual = await chrome.alarms.get(PG_ALARME);
  if (cfg.ligado && cfg.token) {
    if (!atual) await chrome.alarms.create(PG_ALARME, { delayInMinutes: 0.1, periodInMinutes: 1 });
    pgLaco().catch(e => pgStatus('Erro: ' + e.message));
  } else if (atual) {
    await chrome.alarms.clear(PG_ALARME);
  }
}
chrome.alarms.onAlarm.addListener(a => { if (a.name === PG_ALARME) pgLaco().catch(e => pgStatus('Erro: ' + e.message)); });
chrome.runtime.onInstalled.addListener(() => { pgArmarAlarme(); });
chrome.runtime.onStartup.addListener(() => { pgArmarAlarme(); });
// Interruptor/token salvos no popup: acompanha sem precisar de mensagem própria.
chrome.storage.onChanged.addListener((mud, area) => { if (area === 'local' && mud.mlAuto) pgArmarAlarme(); });

// Popup: estado da leitura de páginas.
chrome.runtime.onMessage.addListener((msg, _r, responder) => {
  if (!msg || msg.tipo !== 'ml-paginas') return false;
  (async () => {
    const { mlPaginas } = await chrome.storage.local.get({ mlPaginas: null });
    let servidor = null;
    try { servidor = await mlChamar('/ml/pagina/estado', null, 8000); } catch (e) { servidor = { ok: false, erro: e.message }; }
    responder({ ultimo: mlPaginas, rodando: pgRodando, servidor });
  })().catch(e => { try { responder({ ok: false, erro: e.message }); } catch (_) {} });
  return true;
});
