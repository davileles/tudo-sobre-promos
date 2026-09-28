// ── Captura Tica — inserção de cupons na conta do Mercado Livre ───────────────
// O servidor (baileys-server) decide QUANDO e QUAIS cupons inserir; a extensão
// só executa, aqui no Chrome do operador: abre a página de cupons numa aba em
// segundo plano, digita o código como uma pessoa digitaria, clica em Inserir,
// lê a resposta do ML e devolve o veredito. Nada de chamada direta à API do ML
// — tudo passa pela página, com a sessão logada de verdade.
//
// Carregado pelo background.js via importScripts(). Estado em chrome.storage:
//   mlAuto   { ligado, modo: 'aprovar'|'auto', token, servidor }
//   mlVisita { id, lote, tabId, iniciadaEm }   — visita em andamento
//   mlUltimo { em, texto }                      — última linha de status (popup)

const ML_SERVIDOR_PADRAO = 'https://baileys-server-production-ebfe.up.railway.app';
const ML_ALARME = 'tica-cupons-ml';
const ML_PERIODO_MIN = 5;
const ML_VISITA_EXPIRA_MS = 24 * 60000;   // o servidor expira em 25
const ML_NOTIF_APROVAR = 'tica-ml-aprovar';
const ML_REAVISAR_MS = 30 * 60000;

async function mlCfg() {
  const s = await chrome.storage.local.get({ mlAuto: null });
  return Object.assign({ ligado: false, modo: 'aprovar', token: '', servidor: ML_SERVIDOR_PADRAO }, s.mlAuto || {});
}
async function mlStatus(texto) {
  await chrome.storage.local.set({ mlUltimo: { em: Date.now(), texto: String(texto).slice(0, 200) } });
}

// ── Servidor ─────────────────────────────────────────────────────────────────
async function mlChamar(caminho, corpo, limiteMs) {
  const cfg = await mlCfg();
  if (!cfg.token) throw new Error('token da extensão não configurado');
  const r = await fetch(cfg.servidor.replace(/\/$/, '') + caminho, {
    method: corpo ? 'POST' : 'GET',
    headers: { 'X-Extensao-Token': cfg.token, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(limiteMs || 20000),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('token da extensão recusado pelo servidor');
  if (r.status === 503) throw new Error(d.erro || 'servidor sem token configurado');
  return d;
}

// ── Alarme ───────────────────────────────────────────────────────────────────
async function mlArmarAlarme() {
  const cfg = await mlCfg();
  const atual = await chrome.alarms.get(ML_ALARME);
  if (cfg.ligado && cfg.token) {
    if (!atual) await chrome.alarms.create(ML_ALARME, { delayInMinutes: 0.5, periodInMinutes: ML_PERIODO_MIN });
  } else if (atual) {
    await chrome.alarms.clear(ML_ALARME);
  }
}
chrome.alarms.onAlarm.addListener(a => { if (a.name === ML_ALARME) mlCiclo().catch(e => mlStatus('Erro: ' + e.message)); });

// Um ciclo: ha visita em andamento? expirou? senao pergunta ao servidor.
async function mlCiclo() {
  const cfg = await mlCfg();
  if (!cfg.ligado || !cfg.token) return;

  const { mlVisita } = await chrome.storage.local.get({ mlVisita: null });
  if (mlVisita) {
    if (Date.now() - mlVisita.iniciadaEm < ML_VISITA_EXPIRA_MS) return;   // ainda rodando na aba
    await mlEncerrarVisita(mlVisita, 'expirada');
  }

  if (cfg.modo === 'auto') {
    const r = await mlChamar('/cupons/auto/proximo');
    if (!r.ok) return mlStatus(r.motivo === 'disjuntor' ? 'Desligada pelo disjuntor — religue no bot (/autoinserir)' : 'Servidor: ' + (r.motivo || 'desligada'));
    if (!r.lote || !r.lote.length) return mlStatus(mlMotivoLegivel(r));
    mlIniciarVisita(r).catch(e => mlStatus('Erro na visita: ' + e.message));
    return;
  }

  // Modo com aprovacao: espia sem reservar e pergunta ao operador.
  const r = await mlChamar('/cupons/auto/proximo?espiar=1');
  if (!r.ok) return mlStatus(r.motivo === 'disjuntor' ? 'Desligada pelo disjuntor — religue no bot (/autoinserir)' : 'Servidor: ' + (r.motivo || 'desligada'));
  if (!r.lote || !r.lote.length) return mlStatus(mlMotivoLegivel(r));
  const { mlAvisadoEm } = await chrome.storage.local.get({ mlAvisadoEm: 0 });
  if (Date.now() - mlAvisadoEm < ML_REAVISAR_MS) return;
  await chrome.storage.local.set({ mlAvisadoEm: Date.now() });
  chrome.notifications.create(ML_NOTIF_APROVAR, {
    type: 'basic', iconUrl: 'icones/128.png', requireInteraction: true,
    title: r.lote.length + ' cupom' + (r.lote.length > 1 ? 'ns' : '') + ' do ML para inserir',
    message: r.lote.map(c => c.codigo).join(', ') + '\nInserir agora na sua conta?',
    buttons: [{ title: 'Inserir agora' }, { title: 'Depois' }],
  });
  await mlStatus('Aguardando sua aprovação: ' + r.lote.map(c => c.codigo).join(', '));
}

function mlMotivoLegivel(r) {
  const min = r.aguardar ? Math.round(r.aguardar / 60000) : 0;
  const em = min ? ' (~' + (min >= 60 ? Math.round(min / 60) + ' h' : min + ' min') + ')' : '';
  switch (r.motivo) {
    case 'fila_vazia': return 'Fila vazia — nada para inserir';
    case 'aguardando_atraso': return 'Cupom na fila, esperando o atraso natural' + em;
    case 'pausa_entre_visitas': return 'Pausa entre visitas' + em;
    case 'fora_da_janela': return 'Fora do horário' + em;
    case 'teto': return 'Teto do dia atingido';
    case 'folga': return 'Hoje é dia de folga';
    case 'visita_em_andamento': return 'Visita em andamento';
    default: return 'Servidor: ' + (r.motivo || 'ok');
  }
}

chrome.notifications.onButtonClicked.addListener(async (id, botao) => {
  if (id !== ML_NOTIF_APROVAR) return;
  chrome.notifications.clear(id);
  if (botao !== 0) { await chrome.storage.local.set({ mlAvisadoEm: Date.now() }); return mlStatus('Adiado — pergunto de novo em 30 min'); }
  try {
    const r = await mlChamar('/cupons/auto/proximo');
    if (!r.ok || !r.lote || !r.lote.length) return mlStatus('Nada para inserir agora: ' + mlMotivoLegivel(r));
    mlIniciarVisita(r).catch(e => mlStatus('Erro na visita: ' + e.message));
  } catch (e) { await mlStatus('Erro: ' + e.message); }
});

// ── Visita: aba em segundo plano com a pagina de cupons ───────────────────────
// Desde a 2.3.1 o service worker conduz a visita CUPOM A CUPOM (uma injecao
// curta por cupom), em vez de injetar a visita inteira de uma vez. Motivos:
//  - a pagina de cupons do ML recarrega/navega depois de uma insercao; com a
//    visita inteira numa injecao so, o script morria junto ("Frame with ID 0
//    was removed") e o lote todo voltava para a fila;
//  - uma chamada de API que dura mais de 5 min faz o Chrome matar o service
//    worker — era isso que deixava o popup lento/sem resposta durante a visita
//    e fazia visitas "expirarem" sem resultado.
const ML_FRAME_SUMIU = /frame with id|was removed|no frame|no tab with id|cannot access|tab was closed|receiving end does not exist/i;

async function mlEsperarVivo(ms) {
  // Timer sozinho nao segura o service worker acordado; uma chamada de API a
  // cada poucos segundos segura (reinicia o contador de ociosidade).
  const ate = Date.now() + ms;
  while (Date.now() < ate) {
    await new Promise(r => setTimeout(r, Math.min(10000, Math.max(0, ate - Date.now()))));
    try { await chrome.runtime.getPlatformInfo(); } catch (_) {}
  }
}

async function mlEsperarCarregar(tabId, limiteMs) {
  const ate = Date.now() + limiteMs;
  while (Date.now() < ate) {
    let aba = null;
    try { aba = await chrome.tabs.get(tabId); } catch (_) { return false; }   // aba fechada
    if (aba.status === 'complete') return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return true;
}

async function mlInjetar(tabId, func, args, mundo) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: mundo || 'ISOLATED', func, args: args || [] });
  return r ? r.result : undefined;
}

// Prepara a pagina (de novo, se ela recarregou): escuta no mundo MAIN.
async function mlPrepararPagina(tabId, sel) {
  if (!(await mlEsperarCarregar(tabId, 30000))) throw new Error('a aba de cupons foi fechada');
  await mlInjetar(tabId, mlInstalarEscuta, [sel.apiInputCode], 'MAIN');
}

async function mlIniciarVisita(r) {
  const aba = await chrome.tabs.create({ url: r.seletores.url, active: false });
  const visita = { id: r.visitaId, lote: r.lote, tabId: aba.id, iniciadaEm: Date.now() };
  await chrome.storage.local.set({ mlVisita: visita });
  await mlStatus('Inserindo ' + r.lote.map(c => c.codigo).join(', ') + '…');
  const sel = r.seletores, tempos = r.tempos;
  const rnd = f => f[0] + Math.random() * (f[1] - f[0]);
  let motivoFim = 'concluida';
  try {
    await mlPrepararPagina(aba.id, sel);
    const login = await mlInjetar(aba.id, mlChecarLogin, []);
    if (login) {
      await mlReportarCupom(visita, r.lote[0], { veredito: 'sem_login', mensagem: String(login).slice(0, 120) });
      motivoFim = 'sem_login';
    } else {
      await mlInjetar(aba.id, mlAquecer, [tempos]);
      for (let i = 0; i < r.lote.length; i++) {
        const c = r.lote[i];
        const res = await mlInserirComRecarga(aba.id, c.codigo, sel, tempos);
        await mlReportarCupom(visita, c, res);
        // Um erro encerra a visita: insistir em seguida e assinatura de robo.
        if (['problema', 'sem_login', 'pagina_mudou', 'erro'].includes(res.veredito)) { motivoFim = res.veredito; break; }
        if (i < r.lote.length - 1) await mlEsperarVivo(rnd(tempos.entreCuponsS) * 1000);
      }
      if (motivoFim === 'concluida') await mlEsperarVivo(rnd(tempos.antesDeFecharS) * 1000);
    }
  } catch (e) {
    await mlStatus('Erro na visita: ' + (e.message || e));
    motivoFim = 'erro';
  }
  const { mlVisita } = await chrome.storage.local.get({ mlVisita: null });
  if (mlVisita && mlVisita.id === visita.id) await mlEncerrarVisita(visita, motivoFim);
  const { mlUltimo } = await chrome.storage.local.get({ mlUltimo: null });
  await mlStatus('Visita concluída (' + motivoFim + ')' + (mlUltimo ? ' · ' + mlUltimo.texto.slice(0, 60) : ''));
}

// Um cupom, tolerando a pagina recarregar no meio. Se a resposta do ML ja
// tinha chegado, ela sobrevive no sessionStorage da aba; senao, tenta de novo
// uma vez (se o cupom ja entrou, o ML responde "ja foi adicionado").
async function mlInserirComRecarga(tabId, codigo, sel, tempos) {
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      if (!(await mlEsperarCarregar(tabId, 30000))) return { veredito: 'erro', mensagem: 'a aba de cupons foi fechada' };
      const bruto = await mlInjetar(tabId, mlInserirUm, [codigo, sel, tempos]);
      if (!bruto) return { veredito: 'erro', mensagem: 'sem retorno da página' };
      if (bruto.veredito) return bruto;                      // pagina_mudou etc.
      return mlClassificar(bruto.resp, bruto.textoTela);
    } catch (e) {
      const m = String(e && e.message || e);
      if (!ML_FRAME_SUMIU.test(m)) return { veredito: 'erro', mensagem: 'extensão: ' + m.slice(0, 120) };
      // A pagina recarregou (ou navegou). Espera assentar e le o que ficou.
      try { await mlPrepararPagina(tabId, sel); }
      catch (e2) { return { veredito: 'erro', mensagem: 'extensão: ' + String(e2.message || e2).slice(0, 120) }; }
      await mlEsperarVivo(1500);
      const guardado = await mlInjetar(tabId, mlLerGuardado, [sel, codigo]).catch(() => null);
      if (guardado && guardado.login) return { veredito: 'sem_login', mensagem: String(guardado.login).slice(0, 120) };
      if (guardado && guardado.resp) return mlClassificar(guardado.resp, guardado.textoTela);
      // Recarregou antes da resposta: tenta de novo (so uma vez).
    }
  }
  return { veredito: 'erro', mensagem: 'a página recarregou duas vezes seguidas' };
}

async function mlReportarCupom(visita, c, res) {
  await mlReportar('/cupons/auto/resultado', { visitaId: visita.id, chave: c.chave, veredito: res.veredito,
    rc: res.rc || null, status: res.status || null, mensagem: res.mensagem || '', venceuEm: res.venceuEm || null });
  await mlStatus((ML_ROTULO[res.veredito] || res.veredito) + ' ' + c.codigo + (res.mensagem ? ' — ' + String(res.mensagem).slice(0, 80) : ''));
}

function mlSemAcento(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

// Espelho de ativarCupomMl() do servidor: response_code manda, texto e reserva.
function mlClassificar(resp, textoTela) {
  let corpo = null; try { corpo = JSON.parse(resp ? resp.texto : ''); } catch (_) {}
  const status = resp ? resp.status : 0;
  const rc = (corpo && corpo.tracking && corpo.tracking.event && corpo.tracking.event.eventData && corpo.tracking.event.eventData.response_code) || '';
  const msg = (corpo && corpo.responseMessage) || {};
  const texto = String(msg.text || textoTela || '').trim();
  const t = mlSemAcento(texto);
  const base = { rc, status, mensagem: texto.slice(0, 160) };
  if (status === 403 || (resp && !corpo) || (!rc && /tivemos um problema/.test(t))) return { ...base, veredito: 'problema' };
  if (msg.type === 'success' || (!rc && /(foi|esta) (adicionado|aplicado|ativado)|adicionado com sucesso/.test(t) && !/ja foi/.test(t))) return { ...base, veredito: 'inserido' };
  if (rc === 'PENDING' || /ja foi adicionad|ja esta na sua conta/.test(t)) return { ...base, veredito: 'ja_tinha' };
  if (rc === 'SOLD_OUT' || /esgot/.test(t)) return { ...base, veredito: 'esgotado' };
  if (rc === 'EXPIRED_ACTION' || /venceu|expirou|vencido/.test(t)) return { ...base, veredito: 'vencido' };
  if (rc === 'INVALID_1' || /confira se o cupom|nao existe|invalido/.test(t)) return { ...base, veredito: 'inexistente' };
  if (rc === 'INVALID_6') return { ...base, veredito: 'erro', mensagem: 'INVALID_6 (formato do pedido)' };
  if (!resp && !texto) return { ...base, veredito: 'erro', mensagem: 'sem resposta do ML' };
  return { ...base, veredito: 'problema', mensagem: (rc ? rc + ': ' : '') + texto.slice(0, 140) };
}

async function mlReportar(caminho, corpo) {
  try { return await mlChamar(caminho, corpo); }
  catch (e) { await mlStatus('Falha ao reportar ao servidor: ' + e.message); return null; }
}

async function mlEncerrarVisita(visita, motivo) {
  await mlReportar('/cupons/auto/visita/fim', { visitaId: visita.id, motivo });
  await chrome.storage.local.set({ mlVisita: null });
  if (visita.tabId) chrome.tabs.remove(visita.tabId).catch(() => {});
}

const ML_ROTULO = { inserido: '✅ inserido', ja_tinha: '☑️ já estava', esgotado: '🗑 esgotado', vencido: '🗑 vencido',
  inexistente: '🗑 inexistente', problema: '⚠️ o ML respondeu com erro', sem_login: '🔒 ML deslogado', pagina_mudou: '🧩 página mudou', erro: '❌ erro' };

// Popup: ler/gravar configuracao e estado.
chrome.runtime.onMessage.addListener((msg, _r, responder) => {
  if (!msg || !/^ml-(cfg|salvar|estado|agora)$/.test(msg.tipo)) return false;
  (async () => {
    if (msg.tipo === 'ml-cfg') return responder(await mlCfg());
    if (msg.tipo === 'ml-salvar') {
      const cfg = Object.assign(await mlCfg(), msg.cfg || {});
      cfg.servidor = String(cfg.servidor || ML_SERVIDOR_PADRAO).trim() || ML_SERVIDOR_PADRAO;
      cfg.token = String(cfg.token || '').trim();
      await chrome.storage.local.set({ mlAuto: cfg });
      await mlArmarAlarme();
      return responder({ ok: true });
    }
    if (msg.tipo === 'ml-estado') {
      const s = await chrome.storage.local.get({ mlUltimo: null, mlVisita: null });
      let servidor = null;
      try { servidor = await mlChamar('/cupons/auto/estado', null, 8000); } catch (e) { servidor = { ok: false, erro: e.message }; }
      return responder({ ultimo: s.mlUltimo, visita: s.mlVisita, servidor });
    }
    if (msg.tipo === 'ml-agora') {
      // "Verificar agora" do popup: pula a espera do alarme.
      await chrome.storage.local.set({ mlAvisadoEm: 0 });
      await mlCiclo().catch(e => mlStatus('Erro: ' + e.message));
      return responder({ ok: true });
    }
  })().catch(e => { try { responder({ ok: false, erro: e.message }); } catch (_) {} });
  return true;
});

chrome.runtime.onInstalled.addListener(() => { mlArmarAlarme(); });
chrome.runtime.onStartup.addListener(() => { mlArmarAlarme(); });

// ═══════════════════════════════════════════════════════════════════════════
// Funcoes injetadas na pagina. Serializadas pelo executeScript: nao enxergam
// nada deste arquivo — tudo o que usam vem por argumento. Cada uma e curta
// (segundos), para nenhuma chamada passar do limite do service worker.
// ═══════════════════════════════════════════════════════════════════════════

// Mundo MAIN: embrulha fetch e XHR para capturar a resposta do input-code e
// deixa-la em <html data-tica-resp> e no sessionStorage da aba (que sobrevive
// a pagina recarregar logo depois da insercao).
function mlInstalarEscuta(caminhoApi) {
  if (window.__ticaEscuta) return;
  window.__ticaEscuta = true;
  const guardar = (status, texto) => {
    try {
      const v = JSON.stringify({ status, texto: String(texto).slice(0, 4000), em: Date.now() });
      document.documentElement.setAttribute('data-tica-resp', v);
      sessionStorage.setItem('tica-resp', v);
    } catch (_) {}
  };
  const alvo = u => { try { return String(u || '').includes(caminhoApi); } catch (_) { return false; } };
  const f = window.fetch;
  window.fetch = async function (entrada, init) {
    const url = typeof entrada === 'string' ? entrada : (entrada && entrada.url);
    const resp = await f.apply(this, arguments);
    if (alvo(url)) { try { resp.clone().text().then(t => guardar(resp.status, t)); } catch (_) {} }
    return resp;
  };
  const abrir = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) {
    if (alvo(url)) this.addEventListener('loadend', () => guardar(this.status, this.responseText));
    return abrir.apply(this, arguments);
  };
}

// Mundo ISOLADO: pagina de login no lugar da de cupons = sessao caiu.
function mlChecarLogin() {
  if (/\/login|\/jms\/|registration|hub\/login/i.test(location.href) || document.querySelector('input[type=password], form[action*="login"]')) return location.href;
  return null;
}

// Mundo ISOLADO: como uma pessoa, rola um pouco a lista antes de comecar.
async function mlAquecer(tempos) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = f => f[0] + Math.random() * (f[1] - f[0]);
  await sleep(rnd(tempos.antesDoPrimeiroS) * 1000);
  window.scrollBy({ top: 200 + Math.random() * 400, behavior: 'smooth' });
  await sleep(rnd([600, 1500]));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await sleep(rnd([500, 1200]));
  return true;
}

// Mundo ISOLADO: depois de a pagina recarregar, le a resposta guardada.
function mlLerGuardado(sel, codigo) {
  if (/\/login|\/jms\/|registration|hub\/login/i.test(location.href) || document.querySelector('input[type=password], form[action*="login"]')) return { login: location.href };
  let resp = null;
  // So vale se a resposta guardada e deste cupom (a pagina pode ter recarregado
  // antes de o cupom comecar, com a resposta do anterior ainda la).
  try { const b = sessionStorage.getItem('tica-resp'); if (b && sessionStorage.getItem('tica-cod') === codigo) resp = JSON.parse(b); } catch (_) {}
  const textoTela = [...document.querySelectorAll('.andes-snackbar, [role=alert], [role=status]')].map(e => e.innerText).join(' ').replace(/\s+/g, ' ').trim();
  return { resp, textoTela };
}

// Mundo ISOLADO: UM cupom. Devolve { resp, textoTela } (o service worker
// classifica) ou { veredito: 'pagina_mudou', mensagem } se faltou seletor.
async function mlInserirUm(codigo, sel, tempos) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rnd = f => f[0] + Math.random() * (f[1] - f[0]);
  const esperar = async (fn, ms) => { const ate = Date.now() + ms; while (Date.now() < ate) { const v = fn(); if (v) return v; await sleep(150); } return null; };

  function clicarHumano(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * (0.3 + Math.random() * 0.4), y = r.top + r.height * (0.3 + Math.random() * 0.4);
    const ev = tipo => new MouseEvent(tipo, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window });
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(ev('mousedown'));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(ev('mouseup'));
    el.click();
  }

  async function digitar(campo, texto) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    campo.focus();
    setter.call(campo, '');
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    for (const ch of texto) {
      campo.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      setter.call(campo, campo.value + ch);
      campo.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      campo.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await sleep(rnd(tempos.digitacaoMs));
      if (Math.random() < 0.12) await sleep(rnd(tempos.pausaDigitacaoMs));
    }
    campo.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function lerResposta() {
    const bruto = document.documentElement.getAttribute('data-tica-resp');
    if (!bruto) return null;
    try { return JSON.parse(bruto); } catch (_) { return null; }
  }

  document.documentElement.removeAttribute('data-tica-resp');
  try { sessionStorage.removeItem('tica-resp'); sessionStorage.setItem('tica-cod', codigo); } catch (_) {}
  // Modal pode ja estar aberto do cupom anterior.
  let campo = document.querySelector(sel.campo);
  if (!campo || !campo.offsetParent) {
    const abrir = await esperar(() => document.querySelector(sel.abrir), 6000);
    if (!abrir) return { veredito: 'pagina_mudou', mensagem: 'abrir ' + sel.abrir };
    abrir.scrollIntoView({ block: 'center' });
    await sleep(rnd([400, 1200]));
    clicarHumano(abrir);
    campo = await esperar(() => document.querySelector(sel.campo), 8000);
    if (!campo) return { veredito: 'pagina_mudou', mensagem: 'campo ' + sel.campo };
    await sleep(rnd([500, 1500]));
  }
  await digitar(campo, codigo);
  await sleep(rnd([400, 1100]));
  const botao = await esperar(() => { const b = document.querySelector(sel.botao); return b && !b.disabled ? b : null; }, 5000);
  if (!botao) return { veredito: 'pagina_mudou', mensagem: 'botao ' + sel.botao };
  clicarHumano(botao);
  const resp = await esperar(lerResposta, rnd(tempos.aposClicarS) * 1000 + 8000);
  await sleep(rnd([800, 2000]));
  const modal = document.querySelector(sel.modal);
  const textoTela = (((modal && modal.innerText) || '') + ' ' + [...document.querySelectorAll('.andes-snackbar, [role=alert], [role=status]')].map(e => e.innerText).join(' ')).replace(/\s+/g, ' ').trim();
  // Fecha o modal para o proximo (ou para sair limpo).
  const fechar = document.querySelector(sel.fechar);
  if (fechar) { await sleep(rnd([500, 1500])); clicarHumano(fechar); }
  return { resp, textoTela };
}
