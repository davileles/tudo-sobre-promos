// ── Captura Tica — inserção de cupons na conta do Mercado Livre ───────────────
// O servidor (baileys-server) decide QUANDO e QUAIS cupons inserir; a extensão
// só executa, aqui no Chrome do operador: abre a página de cupons numa aba em
// segundo plano, digita o código como uma pessoa digitaria, clica em Inserir,
// lê a resposta do ML e devolve o veredito. Nada de chamada direta à API do ML
// — tudo passa pela página, com a sessão logada de verdade.
//
// Carregado pelo background.js via importScripts(). Estado em chrome.storage:
//   mlAuto   { ligado, modo: 'aprovar'|'auto', token, servidor }
//   mlVisita { id, lote, tabId, feitos, batida, sel, tempos } — visita em andamento (retomável)
//   mlUltimo { em, texto }                      — última linha de status (popup)

const ML_SERVIDOR_PADRAO = 'https://baileys-server-production-ebfe.up.railway.app';
const ML_ALARME = 'tica-cupons-ml';
const ML_PERIODO_MIN = 1;                 // consulta o servidor a cada minuto (modo enxuto)
const ML_VISITA_PARADA_MS = 5 * 60000;    // sem avanço há tanto = travou (o servidor desiste em 7)
let mlRodandoId = null;                   // visita que ESTE service worker está conduzindo
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
    if (!atual || atual.periodInMinutes !== ML_PERIODO_MIN) await chrome.alarms.create(ML_ALARME, { delayInMinutes: 0.5, periodInMinutes: ML_PERIODO_MIN });
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
    const parada = Date.now() - (mlVisita.batida || mlVisita.iniciadaEm) > ML_VISITA_PARADA_MS;
    if (mlRodandoId === mlVisita.id) {
      if (!parada) return;                                  // andando normalmente
      mlRodandoId = null;                                   // travou numa chamada: abandona
      await mlStatus('Visita travada — encerrando e pedindo lote novo');
      await mlEncerrarVisita(mlVisita, 'travada');
    } else if (!parada) {
      // O Chrome derrubou o service worker no meio da visita: retoma de onde parou.
      mlRodarVisita(mlVisita).catch(e => mlStatus('Erro na visita: ' + e.message));
      return;
    } else {
      await mlEncerrarVisita(mlVisita, 'expirada');
    }
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

// Toda injecao tem prazo: uma aba congelada/descartada pelo Chrome deixava o
// executeScript pendurado para sempre e a visita "sumia" (28/09/2026).
async function mlInjetar(tabId, func, args, mundo, limiteMs) {
  const exec = chrome.scripting.executeScript({ target: { tabId }, world: mundo || 'ISOLATED', func, args: args || [] });
  let timer;
  const prazo = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('a página não respondeu em ' + Math.round((limiteMs || 30000) / 1000) + ' s')), limiteMs || 30000); });
  try {
    const [r] = await Promise.race([exec, prazo]);
    return r ? r.result : undefined;
  } finally { clearTimeout(timer); }
}

// Prepara a pagina (de novo, se ela recarregou): escuta no mundo MAIN.
async function mlPrepararPagina(tabId, sel) {
  if (!(await mlEsperarCarregar(tabId, 30000))) throw new Error('a aba de cupons foi fechada');
  await mlInjetar(tabId, mlInstalarEscuta, [sel.apiInputCode], 'MAIN', 15000);
}

async function mlIniciarVisita(r) {
  const aba = await chrome.tabs.create({ url: r.seletores.url, active: false });
  chrome.tabs.update(aba.id, { autoDiscardable: false }).catch(() => {});
  const visita = { id: r.visitaId, lote: r.lote, tabId: aba.id, iniciadaEm: Date.now(), batida: Date.now(),
    feitos: 0, sel: r.seletores, tempos: r.tempos, preparada: false };
  await chrome.storage.local.set({ mlVisita: visita });
  await mlStatus('Inserindo ' + r.lote.map(c => c.codigo).join(', ') + '…');
  return mlRodarVisita(visita);
}

async function mlSalvarVisita(visita) {
  visita.batida = Date.now();
  const { mlVisita } = await chrome.storage.local.get({ mlVisita: null });
  if (mlVisita && mlVisita.id === visita.id) await chrome.storage.local.set({ mlVisita: visita });
}

// Conduz (ou retoma) a visita a partir de visita.feitos. O progresso vai para
// o storage a cada cupom: se o Chrome matar o service worker, o próximo alarme
// (1 min) continua do cupom seguinte, sem esperar a visita expirar.
async function mlRodarVisita(visita) {
  mlRodandoId = visita.id;
  const sel = visita.sel, tempos = visita.tempos;
  const rnd = f => f[0] + Math.random() * (f[1] - f[0]);
  let motivoFim = 'concluida';
  try {
    // Aba fechada (ou nunca aberta nesta retomada): abre de novo.
    let viva = false; try { viva = !!(await chrome.tabs.get(visita.tabId)); } catch (_) {}
    if (!viva) {
      const aba = await chrome.tabs.create({ url: sel.url, active: false });
      chrome.tabs.update(aba.id, { autoDiscardable: false }).catch(() => {});
      visita.tabId = aba.id; visita.preparada = false;
    }
    await mlSalvarVisita(visita);
    await mlPrepararPagina(visita.tabId, sel);
    if (!visita.preparada) {
      const login = await mlInjetar(visita.tabId, mlChecarLogin, [], null, 15000);
      if (login) {
        await mlReportarCupom(visita, visita.lote[visita.feitos], { veredito: 'sem_login', mensagem: String(login).slice(0, 120) });
        motivoFim = 'sem_login';
      } else {
        await mlAquecerPassos(visita.tabId, tempos);
        visita.preparada = true;
        await mlSalvarVisita(visita);
      }
    }
    if (motivoFim === 'concluida') {
      for (let i = visita.feitos; i < visita.lote.length; i++) {
        const c = visita.lote[i];
        const res = await mlInserirComRecarga(visita.tabId, c.codigo, sel, tempos);
        if (mlRodandoId !== visita.id) return;               // abandonada pelo alarme enquanto esperava
        await mlReportarCupom(visita, c, res);
        visita.feitos = i + 1;
        await mlSalvarVisita(visita);
        // Um erro encerra a visita: insistir em seguida e assinatura de robo.
        if (['problema', 'sem_login', 'pagina_mudou', 'erro'].includes(res.veredito)) { motivoFim = res.veredito; break; }
        if (i < visita.lote.length - 1) await mlEsperarVivo(rnd(tempos.entreCuponsS) * 1000);
      }
      if (motivoFim === 'concluida') await mlEsperarVivo(rnd(tempos.antesDeFecharS) * 1000);
    }
  } catch (e) {
    await mlStatus('Erro na visita: ' + (e.message || e));
    motivoFim = 'erro';
  }
  if (mlRodandoId !== visita.id) return;
  mlRodandoId = null;
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
      const bruto = await mlInserirUmPassos(tabId, codigo, sel, tempos);
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
      const guardado = await mlInjetar(tabId, mlLerGuardado, [sel, codigo], null, 15000).catch(() => null);
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
// Aquecimento conduzido pelo service worker (nada de espera dentro da página).
function mlPassoRolar(y) { window.scrollTo({ top: y, behavior: 'smooth' }); return true; }
async function mlAquecerPassos(tabId, tempos) {
  const rnd = f => f[0] + Math.random() * (f[1] - f[0]);
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  await dorme(rnd(tempos.antesDoPrimeiroS) * 1000);
  await mlInjetar(tabId, mlPassoRolar, [200 + Math.random() * 400], null, 15000);
  await dorme(rnd([600, 1500]));
  await mlInjetar(tabId, mlPassoRolar, [0], null, 15000);
  await dorme(rnd([500, 1200]));
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

// ── UM cupom, em PASSOS CURTOS (28/09/2026) ──────────────────────────────────
// A aba do ML fica em segundo plano e o Chrome estrangula os timers de aba em
// segundo plano (1 s ou mais por setTimeout, piorando com o tempo). Com a
// digitação e as esperas DENTRO da página, cada cupom demorava mais que o
// anterior até estourar o prazo. Agora cada injeção é instantânea (clica,
// digita UMA tecla, lê) e quem espera é o service worker, que não é
// estrangulado. Devolve { resp, textoTela } ou { veredito: 'pagina_mudou' }.

// Mundo ISOLADO — estado do modal.
function mlPassoEstado(sel) {
  const campo = document.querySelector(sel.campo);
  return { campoVisivel: !!(campo && campo.offsetParent), temAbrir: !!document.querySelector(sel.abrir) };
}

// Mundo ISOLADO — prepara o cupom: zera a resposta anterior e o campo.
function mlPassoPreparar(sel, codigo) {
  document.documentElement.removeAttribute('data-tica-resp');
  try { sessionStorage.removeItem('tica-resp'); sessionStorage.setItem('tica-cod', codigo); } catch (_) {}
  const campo = document.querySelector(sel.campo);
  if (!campo) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  campo.focus();
  setter.call(campo, '');
  campo.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// Mundo ISOLADO — digita UMA tecla.
function mlPassoTecla(sel, ch) {
  const campo = document.querySelector(sel.campo);
  if (!campo) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  if (document.activeElement !== campo) campo.focus();
  campo.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
  setter.call(campo, campo.value + ch);
  campo.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
  campo.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  return true;
}
function mlPassoFimDigitacao(sel) {
  const campo = document.querySelector(sel.campo);
  if (campo) campo.dispatchEvent(new Event('change', { bubbles: true }));
  return !!campo;
}

// Mundo ISOLADO — clica em 'abrir' | 'botao' | 'fechar' como uma pessoa.
function mlPassoClicar(sel, qual) {
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
  const campo = document.querySelector(sel.campo);
  const caixa = campo ? campo.closest('[role=dialog], [class*="modal"]') : null;
  let el = null;
  if (qual === 'abrir') el = document.querySelector(sel.abrir);
  else if (qual === 'fechar') el = document.querySelector(sel.fechar);
  else {
    el = document.querySelector(sel.botao);
    // Plano B (ML mudando classes): o botao "Inserir" dentro do dialogo do campo.
    if (!el && caixa) el = [...caixa.querySelectorAll('button')].find(x => /^\s*inserir\s*$/i.test(x.innerText || '')) || null;
    if (el && (el.disabled || el.getAttribute('aria-disabled') === 'true')) return { ok: false, desabilitado: true };
  }
  if (!el) {
    const pistas = caixa ? [...caixa.querySelectorAll('button')].map(x => (x.className || '').split(' ')[0] + ':' + (x.innerText || '').trim().slice(0, 15) + (x.disabled ? '(off)' : '')).join(' | ') : 'sem dialogo';
    return { ok: false, pistas: pistas.slice(0, 110) };
  }
  if (qual === 'abrir') el.scrollIntoView({ block: 'center' });
  clicarHumano(el);
  return { ok: true };
}

// Mundo ISOLADO — resposta capturada pela escuta (mundo MAIN) e texto da tela.
function mlPassoLerResposta() {
  const bruto = document.documentElement.getAttribute('data-tica-resp');
  if (!bruto) return null;
  try { return JSON.parse(bruto); } catch (_) { return null; }
}
function mlPassoTexto(sel) {
  const campo = document.querySelector(sel.campo);
  const modal = document.querySelector(sel.modal) || (campo && campo.closest('[role=dialog]'));
  return (((modal && modal.innerText) || '') + ' ' + [...document.querySelectorAll('.andes-snackbar, [role=alert], [role=status]')].map(e => e.innerText).join(' ')).replace(/\s+/g, ' ').trim();
}

// Service worker — conduz os passos.
async function mlInserirUmPassos(tabId, codigo, sel, tempos) {
  const rnd = f => f[0] + Math.random() * (f[1] - f[0]);
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const inj = (func, args) => mlInjetar(tabId, func, args, null, 15000);
  const esperar = async (fn, ms, passo) => {
    const ate = Date.now() + ms;
    while (Date.now() < ate) { const v = await fn(); if (v) return v; await dorme(passo || 300); }
    return null;
  };

  // Modal pode ja estar aberto do cupom anterior.
  const est = await inj(mlPassoEstado, [sel]);
  if (!est || !est.campoVisivel) {
    if (!(await esperar(async () => (await inj(mlPassoEstado, [sel])).temAbrir, 6000))) return { veredito: 'pagina_mudou', mensagem: 'abrir ' + sel.abrir };
    await dorme(rnd([300, 900]));
    await inj(mlPassoClicar, [sel, 'abrir']);
    if (!(await esperar(async () => (await inj(mlPassoEstado, [sel])).campoVisivel, 8000))) return { veredito: 'pagina_mudou', mensagem: 'campo ' + sel.campo };
    await dorme(rnd([300, 900]));
  }
  if (!(await inj(mlPassoPreparar, [sel, codigo]))) return { veredito: 'pagina_mudou', mensagem: 'campo ' + sel.campo };
  for (const ch of codigo) {
    if (!(await inj(mlPassoTecla, [sel, ch]))) return { veredito: 'pagina_mudou', mensagem: 'campo sumiu durante a digitação' };
    await dorme(rnd(tempos.digitacaoMs));
    if (Math.random() < 0.12) await dorme(rnd(tempos.pausaDigitacaoMs));
  }
  await inj(mlPassoFimDigitacao, [sel]);
  await dorme(rnd([300, 800]));

  let clique = null;
  const ate = Date.now() + 5000;
  while (Date.now() < ate) {
    clique = await inj(mlPassoClicar, [sel, 'botao']);
    if (clique && clique.ok) break;
    await dorme(300);
  }
  if (!clique || !clique.ok) return { veredito: 'pagina_mudou', mensagem: 'botao — ' + ((clique && clique.pistas) || 'desabilitado') };

  const resp = await esperar(() => inj(mlPassoLerResposta, []), rnd(tempos.aposClicarS) * 1000 + 8000, 300);
  await dorme(rnd([600, 1500]));
  const textoTela = await inj(mlPassoTexto, [sel]).catch(() => '');
  await dorme(rnd([300, 900]));
  await inj(mlPassoClicar, [sel, 'fechar']).catch(() => {});   // fecha o modal para o proximo
  return { resp, textoTela };
}
