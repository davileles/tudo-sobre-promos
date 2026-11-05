// ── Captura Tica — leitura de página de produto do Mercado Livre ──────────────
// Desde 11/10/2026 a página pública de produto do ML responde ao IP do Railway
// com a tela "Seguridad" (/captcha/wall). O servidor (baileys-server) passou a
// pedir a página AQUI: este módulo fica em long-poll em /ml/pagina/proximo e,
// quando chega um pedido, abre a página de verdade no Chrome do operador e
// devolve o HTML em /ml/pagina/resultado; quem interpreta é o servidor.
//
// Como a página é aberta (2.11.0, 05/11/2026): numa JANELA PRÓPRIA,
// MINIMIZADA, criada pela extensão e reaproveitada para todas as leituras —
// navegação real, igual a uma pessoa abrindo o anúncio. Não abre aba no meio
// das suas e não rouba o foco; fecha sozinha após PG_OCIOSO_MS sem pedidos.
// Até a 2.10.0 era um fetch() do service worker: com ou sem cookie, o ML
// passou a responder a todo pedido desse tipo com a tela de verificação,
// enquanto a mesma página abria normal numa aba.
// Quando o ML pede verificação, o servidor para e avisa no WhatsApp; você
// resolve neste Chrome e clica em "Já resolvi" no popup.
//
// Usa a mesma configuração dos cupons (mlAuto: ligado, token, servidor): um
// interruptor só para as duas coisas. Carregado pelo background.js via
// importScripts(), depois de cupons-ml.js (usa mlCfg e mlChamar de lá).
// Estado em chrome.storage:
//   local.mlPaginas   { em, texto, hoje } — última linha de status (popup)
//   session.pgJanela  { win, tab, usoEm } — a janela minimizada em uso

const PG_ALARME = 'tica-paginas-ml';
const PG_ESPERA_S = 25;                   // quanto o servidor segura o long-poll
const PG_CARGA_MS = 25000;                // prazo para a página carregar
const PG_FIRMAR_MS = 1500;                // depois de carregar, o ML ainda pode redirecionar
const PG_OCIOSO_MS = 5 * 60000;           // janela fecha sozinha após 5 min sem pedidos
const PG_ESPACO_MS = [4000, 8000];        // pausa entre páginas, como uma pessoa navegando
let pgRodando = false;                    // laço de long-poll vivo NESTE service worker

const pgDormir = ms => new Promise(r => setTimeout(r, ms));
async function pgStatus(texto, extra) {
  const { mlPaginas } = await chrome.storage.local.get({ mlPaginas: null });
  await chrome.storage.local.set({ mlPaginas: Object.assign({}, mlPaginas, extra || {}, { em: Date.now(), texto: String(texto).slice(0, 200) }) });
}

// ── Janela minimizada própria ────────────────────────────────────────────────
async function pgJanelaGuardada() {
  const { pgJanela } = await chrome.storage.session.get({ pgJanela: null });
  if (!pgJanela) return null;
  try {
    const aba = await chrome.tabs.get(pgJanela.tab);
    if (aba && aba.windowId === pgJanela.win) return pgJanela;
  } catch (_) {}
  await chrome.storage.session.remove('pgJanela');
  return null;
}

async function pgAbaDeLeitura() {
  const j = await pgJanelaGuardada();
  if (j) return j;
  const w = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false, type: 'normal' });
  const tab = w.tabs && w.tabs[0] ? w.tabs[0].id : (await chrome.tabs.query({ windowId: w.id }))[0].id;
  const nova = { win: w.id, tab, usoEm: Date.now() };
  await chrome.storage.session.set({ pgJanela: nova });
  return nova;
}

async function pgFecharSeOciosa() {
  const j = await pgJanelaGuardada();
  if (!j || Date.now() - (j.usoEm || 0) < PG_OCIOSO_MS) return;
  await chrome.storage.session.remove('pgJanela');
  try { await chrome.windows.remove(j.win); } catch (_) {}
}

function pgEsperarCarga(tabId, ms) {
  return new Promise(resolve => {
    let timer = null;
    const fim = ok => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(ouvir); resolve(ok); };
    const ouvir = (id, info) => { if (id === tabId && info.status === 'complete') fim(true); };
    chrome.tabs.onUpdated.addListener(ouvir);
    timer = setTimeout(() => fim(false), ms);
  });
}

// ── Leitura de UMA página ────────────────────────────────────────────────────
async function pgBuscar(url) {
  const j = await pgAbaDeLeitura();
  j.usoEm = Date.now();
  await chrome.storage.session.set({ pgJanela: j });
  const carregou = pgEsperarCarga(j.tab, PG_CARGA_MS);
  await chrome.tabs.update(j.tab, { url });
  let ok = await carregou;
  // Redirecionamento por script depois do "complete" (tela de verificação):
  // espera firmar e, se voltou a carregar, aguarda de novo uma vez.
  await pgDormir(PG_FIRMAR_MS);
  try {
    const aba = await chrome.tabs.get(j.tab);
    if (aba.status === 'loading') ok = await pgEsperarCarga(j.tab, PG_CARGA_MS);
  } catch (_) {}
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: j.tab },
    func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
  });
  const v = r && r.result;
  if (!v || !v.html) throw new Error(ok ? 'página sem conteúdo' : 'página não carregou no prazo');
  j.usoEm = Date.now();
  await chrome.storage.session.set({ pgJanela: j });
  return { url: v.url || url, status: 200, html: v.html };
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
      await pgStatus((resultado.erro ? 'Falhou: ' + resultado.erro : (v && v.veredito === 'bloqueada' ? 'ML pediu verificação — resolva na janela minimizada "Captura Tica" ou pelo link do aviso' : 'Página lida'))
        + ' · ' + (p.motivo === 'sonda' ? 'sonda' : p.motivo === 'teste' ? 'teste da verificação' : 'leitura'), { hoje, dia: new Date().toDateString() });
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
chrome.alarms.onAlarm.addListener(a => {
  if (a.name !== PG_ALARME) return;
  pgFecharSeOciosa().catch(() => {});
  pgLaco().catch(e => pgStatus('Erro: ' + e.message));
});
chrome.runtime.onInstalled.addListener(() => { pgArmarAlarme(); });
chrome.runtime.onStartup.addListener(() => { pgArmarAlarme(); });
// Interruptor/token salvos no popup: acompanha sem precisar de mensagem própria.
chrome.storage.onChanged.addListener((mud, area) => { if (area === 'local' && mud.mlAuto) pgArmarAlarme(); });

// Popup: "Já resolvi" — pede ao servidor que teste agora a página bloqueada.
chrome.runtime.onMessage.addListener((msg, _r, responder) => {
  if (!msg || msg.tipo !== 'ml-paginas-testar') return false;
  (async () => {
    let r;
    try { r = await mlChamar('/ml/pagina/testar', {}, 60000); } catch (e) { r = { ok: false, erro: e.message }; }
    if (r && r.ok && r.liberada === true) await pgStatus('Verificação resolvida — leitura retomada');
    else if (r && r.ok && r.liberada === false) await pgStatus('O ML ainda pede verificação nesta página');
    responder(r);
  })().catch(e => { try { responder({ ok: false, erro: e.message }); } catch (_) {} });
  return true;
});

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
