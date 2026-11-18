// ── Captura Tica — relatório mensal da Shopee para as Notas Shopee ────────────
// (2.14.0, 18/11/2026)
// O servidor (baileys-server, notas-shopee.js) emite as NFS-e das comissões
// extras que os vendedores pagam ao Tica Promos. Os dados vêm do "Relatório
// mensal para Documentos Fiscais" do painel de afiliados da Shopee, e só um
// navegador logado consegue lê-lo: a página assina cada chamada, e um pedido
// feito por fora cai em verificação anti-robô.
//
// Então, a cada 30 min, este módulo pergunta ao servidor se há relatório para
// buscar (GET /notas-shopee/tarefa). Havendo, abre a página numa JANELA
// MINIMIZADA própria, troca para 100 linhas por página e vai passando as
// páginas pela própria tela — exatamente o que uma pessoa faria. Não chama a
// API da Shopee: só escuta as respostas que a página recebe. Junta as linhas
// do mês pedido e devolve em POST /notas-shopee/relatorio. A janela fecha no fim.
//
// Usa a mesma configuração dos cupons (mlAuto: ligado, token, servidor).
// Carregado pelo background.js via importScripts(), depois de cupons-ml.js.

const RS_ALARME = 'tica-relatorio-shopee';
const RS_URL = 'https://affiliate.shopee.com.br/report/monthly_report';
const RS_MAX_PAGINAS = 40;
let rsRodando = false;

const rsDormir = ms => new Promise(r => setTimeout(r, ms));
async function rsStatus(texto) {
  await chrome.storage.local.set({ rsUltimo: { em: Date.now(), texto: String(texto).slice(0, 200) } });
}

function rsEsperarCarga(tabId, ms) {
  return new Promise(resolve => {
    let timer = null;
    const fim = ok => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(ouvir); resolve(ok); };
    const ouvir = (id, info) => { if (id === tabId && info.status === 'complete') fim(true); };
    chrome.tabs.onUpdated.addListener(ouvir);
    timer = setTimeout(() => fim(false), ms);
  });
}

async function rsNaPagina(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: args || [] });
  return r && r.result;
}

// ── Funções que rodam DENTRO da página (world MAIN) ──────────────────────────
function rsPgInstalarEscuta() {
  if (window.__ticaRel) return 'ja';
  window.__ticaRel = [];
  const guardar = (txt) => {
    try {
      const j = JSON.parse(txt);
      const d = j && j.data && j.data.queryAffiliateMonthlyReport;
      if (d && Array.isArray(d.list)) window.__ticaRel.push({ em: Date.now(), list: d.list, pagination: d.pagination || {} });
    } catch (_) {}
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__ticaU = String(u || ''); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (this.__ticaU.indexOf('/api/v3/gql') >= 0) this.addEventListener('load', () => { try { guardar(this.responseText); } catch (_) {} });
    return os.apply(this, arguments);
  };
  const of = window.fetch;
  window.fetch = async function (u) {
    const r = await of.apply(this, arguments);
    try { if (String(u && u.url || u).indexOf('/api/v3/gql') >= 0) r.clone().text().then(guardar).catch(() => {}); } catch (_) {}
    return r;
  };
  return 'ok';
}
function rsPgCapturas() {
  return (window.__ticaRel || []).map(c => ({ em: c.em, pagination: c.pagination, list: c.list }));
}
function rsPgCem() {
  const caixa = document.querySelector('.ant-pagination-options-size-changer');
  if (!caixa) return 'sem-seletor';
  if (/100\s*\/\s*p/.test(caixa.textContent || '')) return 'ja-100';
  const alvo = caixa.querySelector('.ant-select-selection, .ant-select-selector') || caixa;
  alvo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  alvo.click();
  return 'aberto';
}
function rsPgEscolherCem() {
  const op = [...document.querySelectorAll('.ant-select-dropdown-menu-item, .ant-select-item-option')].find(e => /^\s*100\s*\/\s*p/.test(e.textContent || ''));
  if (!op) return false;
  op.click();
  return true;
}
function rsPgPesquisar() {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === 'Pesquisar');
  if (b) { b.click(); return true; }
  return false;
}
function rsPgProxima() {
  const li = document.querySelector('li.ant-pagination-next');
  if (!li || li.classList.contains('ant-pagination-disabled') || li.getAttribute('aria-disabled') === 'true') return false;
  (li.querySelector('a, button') || li).click();
  return true;
}
function rsPgAmostra() {
  return [...document.querySelectorAll('.ant-table-row')].slice(0, 5).map(r => {
    const c = [...r.children].map(td => (td.textContent || '').trim());
    return { shopId: c[2] || '', texto: c[3] || '' };
  });
}

// ── Leitura completa de um mês ───────────────────────────────────────────────
async function rsEsperarCaptura(tabId, condicao, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const caps = (await rsNaPagina(tabId, rsPgCapturas)) || [];
    const achou = caps.slice().reverse().find(condicao);
    if (achou) return achou;
    await rsDormir(800);
  }
  return null;
}

async function rsLer(mes) {
  const w = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false, type: 'normal' });
  const tabId = w.tabs && w.tabs[0] ? w.tabs[0].id : (await chrome.tabs.query({ windowId: w.id }))[0].id;
  try {
    const carregou = rsEsperarCarga(tabId, 40000);
    await chrome.tabs.update(tabId, { url: RS_URL });
    await carregou;
    await rsDormir(4000);
    const aba = await chrome.tabs.get(tabId);
    if (!/^https:\/\/affiliate\.shopee\.com\.br\/report\/monthly_report/.test(aba.url || '')) {
      throw Object.assign(new Error(/login/i.test(aba.url || '') ? 'pediu login' : 'verificação/redirecionamento'), { url: aba.url });
    }
    await rsNaPagina(tabId, rsPgInstalarEscuta);
    // 100 por página: a troca dispara a busca da página 1 já com 100 linhas.
    const passo = await rsNaPagina(tabId, rsPgCem);
    if (passo === 'aberto') { await rsDormir(900); await rsNaPagina(tabId, rsPgEscolherCem); }
    else await rsNaPagina(tabId, rsPgPesquisar);
    let atual = await rsEsperarCaptura(tabId, c => String(c.pagination.pageNum) === '1', 30000);
    if (!atual) { await rsNaPagina(tabId, rsPgPesquisar); atual = await rsEsperarCaptura(tabId, c => String(c.pagination.pageNum) === '1', 30000); }
    if (!atual) throw new Error('a página não trouxe o relatório (layout mudou?)');
    const amostra = (await rsNaPagina(tabId, rsPgAmostra)) || [];
    const vistos = new Map();
    let paginas = 0;
    for (;;) {
      paginas++;
      for (const it of atual.list || []) vistos.set(it.completedMonth + '|' + it.shopId, it);
      const meses = (atual.list || []).map(it => String(it.completedMonth));
      const pn = Number(atual.pagination.pageNum || 1), ps = Number(atual.pagination.pageSize || 10), tot = Number(atual.pagination.totalCount || 0);
      await rsStatus('Relatório Shopee ' + mes + ': página ' + pn + ' de ' + Math.max(1, Math.ceil(tot / ps)));
      if (meses.length && meses.every(m => m < mes)) break;                     // já passou do mês pedido (lista vem do mais novo)
      if (pn * ps >= tot || paginas >= RS_MAX_PAGINAS) break;
      await rsDormir(2000 + Math.random() * 2500);
      if (!(await rsNaPagina(tabId, rsPgProxima))) break;
      const prox = await rsEsperarCaptura(tabId, c => Number(c.pagination.pageNum) === pn + 1, 30000);
      if (!prox) throw new Error('a página ' + (pn + 1) + ' não carregou');
      atual = prox;
    }
    const itens = [...vistos.values()].filter(it => String(it.completedMonth) === mes);
    return { itens, amostra, paginas };
  } finally {
    try { await chrome.windows.remove(w.id); } catch (_) {}
  }
}

async function rsVerificar() {
  if (rsRodando) return;
  const cfg = await mlCfg();
  if (!cfg.ligado || !cfg.token) return;
  rsRodando = true;
  try {
    let r;
    try { r = await mlChamar('/notas-shopee/tarefa', null, 20000); }
    catch (e) { await rsStatus('Servidor: ' + e.message); return; }
    if (!r || !r.ok || !r.tarefa) return;
    const mes = String(r.tarefa.mes);
    await rsStatus('Lendo o relatório da Shopee de ' + mes.slice(4) + '/' + mes.slice(0, 4) + '…');
    let corpo;
    try {
      const l = await rsLer(mes);
      corpo = { mes, itens: l.itens, amostra: l.amostra, paginas: l.paginas };
    } catch (e) {
      corpo = { mes, erro: e.message, url: e.url || '' };
    }
    let v = null;
    try { v = await mlChamar('/notas-shopee/relatorio', corpo, 60000); }
    catch (e) { await rsStatus('Falha ao enviar o relatório: ' + e.message); return; }
    await rsStatus(corpo.erro ? 'Relatório não lido: ' + corpo.erro
      : (v && v.ok ? 'Relatório ' + mes.slice(4) + '/' + mes.slice(0, 4) + ' enviado: ' + v.notas + ' notas' : 'Servidor recusou o relatório: ' + (v && v.erro || '?')));
  } finally {
    rsRodando = false;
  }
}

async function rsArmarAlarme() {
  const cfg = await mlCfg();
  const atual = await chrome.alarms.get(RS_ALARME);
  if (cfg.ligado && cfg.token) {
    if (!atual) await chrome.alarms.create(RS_ALARME, { delayInMinutes: 1, periodInMinutes: 30 });
  } else if (atual) {
    await chrome.alarms.clear(RS_ALARME);
  }
}
chrome.alarms.onAlarm.addListener(a => { if (a.name === RS_ALARME) rsVerificar().catch(e => rsStatus('Erro: ' + e.message)); });
chrome.runtime.onInstalled.addListener(() => { rsArmarAlarme(); });
chrome.runtime.onStartup.addListener(() => { rsArmarAlarme(); });
chrome.storage.onChanged.addListener((mud, area) => { if (area === 'local' && mud.mlAuto) rsArmarAlarme(); });

// Popup: "buscar agora" e estado.
chrome.runtime.onMessage.addListener((msg, _r, responder) => {
  if (!msg || (msg.tipo !== 'relatorio-shopee' && msg.tipo !== 'relatorio-shopee-agora')) return false;
  (async () => {
    if (msg.tipo === 'relatorio-shopee-agora') rsVerificar().catch(e => rsStatus('Erro: ' + e.message));
    const { rsUltimo } = await chrome.storage.local.get({ rsUltimo: null });
    responder({ ultimo: rsUltimo, rodando: rsRodando });
  })().catch(e => { try { responder({ ok: false, erro: e.message }); } catch (_) {} });
  return true;
});
