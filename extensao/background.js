// ── Captura Tica ───────────────────────────────────────────────────────────────
// Junta links de produtos numa fila local. NAO cadastra nada: o cadastro
// continua sendo feito por voce no painel, com a lista inteira na mao, onde
// escolhe cupom e modo de disparo. A extensao so evita o copia-e-cola.

const FILA = 'fila';

async function lerFila() {
  const s = await chrome.storage.local.get({ [FILA]: [] });
  return Array.isArray(s[FILA]) ? s[FILA] : [];
}

async function gravarFila(fila) {
  await chrome.storage.local.set({ [FILA]: fila });
  await pintarBadge(fila.length);
}

async function pintarBadge(n) {
  const qtd = typeof n === 'number' ? n : (await lerFila()).length;
  chrome.action.setBadgeText({ text: qtd ? String(qtd) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#3d63dd' });
}

// ── MENUS ─────────────────────────────────────────────────────────────────────
// ── LOJAS ACEITAS ─────────────────────────────────────────────────────────────
// O painel so transforma em produto o link de quatro lojas nativas e dos
// anunciantes da conta Awin. Sem esta checagem o link entra na fila e so e
// recusado la na frente, no cadastro — depois de voce ja ter varrido a loja
// inteira. Melhor descobrir no clique.
const SERVIDOR = 'https://baileys-server-production-ebfe.up.railway.app';
const TTL_LOJAS = 24 * 60 * 60 * 1000;   // a lista Awin muda raramente

const NATIVAS = [
  'amazon.com.br', 'amazon.com', 'amzn.to', 'a.co',
  'mercadolivre.com.br', 'mercadolibre.com', 'mercadolivre.com',
  'shopee.com.br',
  'magazineluiza.com.br', 'magazinevoce.com.br',
];

function casaDominio(host, dominio) {
  return host === dominio || host.endsWith('.' + dominio);
}

// Le do cache; so vai a rede quando vencido. Falha de rede nao bloqueia nada:
// sem lista, deixa passar e o cadastro decide — bloquear por indisponibilidade
// de rede seria pior que o problema original.
async function dominiosAwin() {
  const s = await chrome.storage.local.get({ awin: null, awinEm: 0 });
  if (Array.isArray(s.awin) && Date.now() - s.awinEm < TTL_LOJAS) return s.awin;
  try {
    const r = await fetch(SERVIDOR + '/awin/programas', { signal: AbortSignal.timeout(12000) });
    const d = await r.json();
    const doms = new Set();
    for (const p of (d.programas || [])) {
      for (const vd of (p.validDomains || [])) {
        const dom = String(vd.domain || '').toLowerCase().replace(/^\*\./, '').replace(/^\./, '').replace(/^www\./, '');
        if (dom) doms.add(dom);
      }
      try {
        const h = new URL(p.displayUrl).hostname.toLowerCase().replace(/^www\./, '');
        if (h) doms.add(h);
      } catch (_) { /* displayUrl vazio ou torto — validDomains ja cobre */ }
    }
    const lista = [...doms];
    if (lista.length) await chrome.storage.local.set({ awin: lista, awinEm: Date.now() });
    return lista;
  } catch (_) {
    return Array.isArray(s.awin) ? s.awin : null;   // null = não deu para saber
  }
}

// 'ok' | 'nao' | 'incerto'
async function lojaAceita(url) {
  const h = host(url).replace(/^www\./, '');
  if (!h) return 'incerto';
  if (NATIVAS.some(d => casaDominio(h, d))) return 'ok';
  const awin = await dominiosAwin();
  if (awin === null) return 'incerto';
  return awin.some(d => casaDominio(h, d)) ? 'ok' : 'nao';
}

// Em listagem o produto costuma ser uma imagem-link, e o Chrome mostra os tres
// de uma vez — os rotulos precisam dizer sozinhos em que cada um age.
const MENUS = [
  { id: 'tsp-pagina', title: '➕ Guardar ESTA PÁGINA na fila da Vitrine', contexts: ['page', 'image', 'selection'] },
  { id: 'tsp-link',   title: '➕ Guardar O LINK na fila — lê o título (~2s)', contexts: ['link'] },
  { id: 'tsp-rapido', title: '⚡ Guardar O LINK na fila — instantâneo', contexts: ['link'] },
  { id: 'tsp-disparo', title: '🚀 Disparar ESTA PÁGINA agora…', contexts: ['page', 'image', 'selection'] },
  { id: 'tsp-disparo-link', title: '🚀 Disparar O LINK agora…', contexts: ['link'] },
];

function criarMenus() {
  chrome.contextMenus.removeAll(() => MENUS.forEach(m => chrome.contextMenus.create(m)));
}
chrome.runtime.onInstalled.addListener(() => { criarMenus(); pintarBadge(); });
// O service worker hiberna; recriar no startup evita menu sumido apos reiniciar.
chrome.runtime.onStartup.addListener(() => { criarMenus(); pintarBadge(); });

// ── COLETA (roda dentro da pagina) ────────────────────────────────────────────
// Serializada e injetada por chrome.scripting.executeScript — nao enxerga nada
// do escopo daqui.
function coletarDaPagina() {
  const limpar = s => String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–|]\s*(Amazon\.com\.br|Amazon)\s*$/i, '')
    .replace(/\s*\|\s*(Shopee Brasil|MercadoLivre|Mercado Livre|Magazine Luiza|Magalu).*$/i, '')
    .replace(/[|;]+/g, ' ')          // separador reservado ao formato da linha
    .replace(/\s+/g, ' ')
    .trim()
    // Corte na ultima palavra inteira. O .slice(0,140) cru partia no meio do
    // caractere ("...12V Displa"), e esse recorte vence o titulo real da pagina
    // no servidor — entrava torto na vitrine e saia torto no WhatsApp.
    .replace(/^(.{0,180})(?:\s.*)?$/s, '$1');

  const num = v => {
    const n = Number(String(v).replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
  };

  let titulo = '', preco = null, precoDe = null;

  // 1. JSON-LD — o mais confiavel quando existe
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const bruto = JSON.parse(el.textContent);
      const fila = Array.isArray(bruto) ? bruto.slice() : [bruto];
      while (fila.length) {
        const n = fila.shift();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n['@graph'])) fila.push(...n['@graph']);
        const tipo = [].concat(n['@type'] || []).join(' ');
        if (!/Product/i.test(tipo)) continue;
        if (!titulo && n.name) titulo = n.name;
        const of = [].concat(n.offers || [])[0];
        if (of && !preco) preco = num(of.price ?? of.lowPrice);
      }
    } catch (_) { /* JSON-LD quebrado e comum — tenta a proxima fonte */ }
  }

  // 2. Seletores das lojas grandes
  if (!titulo) titulo = document.querySelector('#productTitle')?.textContent
             || document.querySelector('.ui-pdp-title')?.textContent
             || document.querySelector('h1[data-testid="heading-product-title"]')?.textContent
             || '';
  if (!preco) {
    preco = num(document.querySelector('.a-price .a-offscreen')?.textContent
              || document.querySelector('meta[itemprop="price"]')?.content
              || document.querySelector('meta[property="product:price:amount"]')?.content
              || '');
  }
  precoDe = num(document.querySelector('.basisPrice .a-offscreen')?.textContent
             || document.querySelector('span.a-price.a-text-price .a-offscreen')?.textContent
             || document.querySelector('.andes-money-amount--previous .andes-money-amount__fraction')?.textContent
             || document.querySelector('meta[property="product:original_price:amount"]')?.content
             || '');
  if (precoDe && preco && precoDe <= preco) precoDe = null;

  if (!titulo) titulo = document.querySelector('meta[property="og:title"]')?.content || document.title || '';

  // Mercado Livre: anuncio que pertence a catalogo traz o canonical em /p/MLB.
  // O id de catalogo e o unico que a API oficial cobre (/products/{id}/items);
  // o id de anuncio (produto.mercadolivre.com.br/MLB-...) so a pagina le, e com
  // o antibot ligado nao ha plano B. Leitura de DOM da pagina ja aberta —
  // nenhuma requisicao a mais.
  let endereco = location.href;
  if (/mercadoli(vre|bre)\./i.test(location.hostname)) {
    const canon = document.querySelector('link[rel="canonical"]')?.href || '';
    if (/\/(?:p|up)\/MLBU?\d{6,}/i.test(canon)) endereco = canon;
  }

  return { titulo: limpar(titulo), preco, precoDe, url: endereco };
}

// ── MONTAGEM DA LINHA ─────────────────────────────────────────────────────────
const RECONSULTA_PRECO = /(^|\.)(amazon\.com\.br|amazon\.com|amzn\.to|mercadolivre\.com\.br|mercadolibre\.com|shopee\.com\.br)$/i;
const MAGALU = /(^|\.)(magazineluiza\.com\.br|magazinevoce\.com\.br)$/i;

function host(url) { try { return new URL(url).hostname; } catch (_) { return ''; } }

// Sempre com centavos: o parser le "249,9" como 249 e 9, fica com o menor e
// cadastra o produto a R$ 9,00.
function moeda(v) { return Number(v).toFixed(2).replace('.', ','); }

function montarLinha(d) {
  const h = host(d.url);
  const partes = [];

  // Amazon, Mercado Livre e Shopee reconsultam o preco no disparo — preco de
  // cadastro ali so envelheceria.
  if (RECONSULTA_PRECO.test(h)) {
    if (d.titulo) partes.push(d.titulo);
    partes.push(d.url);
    return partes.join(' | ');
  }

  // Magalu, Awin e lojas nao identificadas usam o preco do cadastro como plano B.
  // Na Magalu, ate a correcao de radar-magalu.js estar no ar, qualquer digito do
  // titulo virava candidato a preco — sem o titulo, o nome sai do slug da URL.
  const tituloPerigoso = MAGALU.test(h) && /\d/.test(d.titulo);
  if (d.titulo && !tituloPerigoso) partes.push(d.titulo);
  partes.push(d.url);
  if (d.preco)   partes.push(moeda(d.preco));
  if (d.precoDe) partes.push(moeda(d.precoDe));
  return partes.join(' | ');
}

// ── ABA EM BACKGROUND (botao direito sobre um link) ───────────────────────────
async function coletarDeLink(url) {
  const aba = await chrome.tabs.create({ url, active: false });
  try {
    await new Promise(resolve => {
      const limite = setTimeout(finalizar, 20000);
      function ouvinte(id, ch) { if (id === aba.id && ch.status === 'complete') finalizar(); }
      function finalizar() {
        clearTimeout(limite);
        chrome.tabs.onUpdated.removeListener(ouvinte);
        resolve();
      }
      chrome.tabs.onUpdated.addListener(ouvinte);
    });
    // Lojas com render tardio (Shopee) precisam de um respiro apos o 'complete'.
    await new Promise(r => setTimeout(r, 1200));
    const [r] = await chrome.scripting.executeScript({ target: { tabId: aba.id }, func: coletarDaPagina });
    return r?.result || { titulo: '', preco: null, precoDe: null, url };
  } catch (_) {
    return { titulo: '', preco: null, precoDe: null, url };
  } finally {
    chrome.tabs.remove(aba.id).catch(() => {});
  }
}

function avisar(titulo, corpo) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icones/128.png', title: titulo, message: corpo });
}

// Em pagina de resultados, o link do produto costuma vir embrulhado num
// redirecionador de anuncio ("/sspa/click?...&url=%2FProduto%2Fdp%2FB0XXXX").
// Sem abrir a pagina, o unico jeito de chegar ao produto e desembrulhar aqui —
// senao o que entra na fila e a URL do rastreador, que nao vira produto nenhum.
function desembrulhar(url) {
  try {
    const u = new URL(url);
    // Mercado Livre: card patrocinado da busca vem como contador de clique
    // (click1.mercadolivre.com.br/mclics/clicks/...). O "a=" e cifrado, mas o
    // item esta em claro em pdp_filters=item_id:MLBxxxx (e em wid= no hash).
    // So leitura de string — nenhuma consulta a pagina.
    if (/^click\d*\.mercadoli(vre|bre)\./i.test(u.hostname)) {
      const m = (u.searchParams.get('pdp_filters') || '').match(/item_id:(ML[A-Z])(\d+)/i)
             || u.hash.match(/[?&#]wid=(ML[A-Z])(\d+)/i);
      if (!m) return url;
      const site = m[1].toUpperCase();
      const dom = site === 'MLB' ? 'produto.mercadolivre.com.br' : 'articulo.mercadolibre.com';
      return 'https://' + dom + '/' + site + '-' + m[2];
    }
    // Amazon: /sspa/click?...&url=%2Fdp%2FB0XXXX e /gp/slredirect
    if (!/\/(sspa\/click|gp\/slredirect)/i.test(u.pathname)) return url;
    const dentro = u.searchParams.get('url') || u.searchParams.get('u');
    if (!dentro) return url;
    return new URL(decodeURIComponent(dentro), u.origin).toString();
  } catch (_) { return url; }
}

// URL sem os rastreadores que fazem o mesmo produto parecer dois na fila.
function chaveDe(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    [...u.searchParams.keys()]
      .filter(k => /^(utm_|ref|ref_|tag|psc|th|sr|qid|smid|linkCode|creative|camp)/i.test(k))
      .forEach(k => u.searchParams.delete(k));
    return u.toString().replace(/\/$/, '');
  } catch (_) { return String(url); }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  chrome.action.setBadgeText({ text: '...' });
  try {
    // Recusa antes de qualquer trabalho: nao vale abrir aba oculta para ler o
    // titulo de um produto que o cadastro vai negar.
    const alvo = info.linkUrl ? desembrulhar(info.linkUrl) : (tab?.url || '');
    if (!alvo || !/^https?:/i.test(alvo)) throw new Error('link inválido');
    if ((await lojaAceita(alvo)) === 'nao') {
      await pintarBadge();
      avisar('Loja não suportada',
        host(alvo).replace(/^www\./, '') + ' não está entre as lojas que o painel '
        + 'consegue cadastrar (Amazon, Mercado Livre, Shopee, Magalu e os anunciantes Awin).');
      return;
    }

    // Disparo direto: nao entra na fila. Abre a janela de confirmacao, que
    // cadastra, oferece os cupons da loja e so envia com clique explicito —
    // mensagem em grupo nao tem desfazer.
    if (info.menuItemId === 'tsp-disparo' || info.menuItemId === 'tsp-disparo-link') {
      const d = info.linkUrl
        ? await coletarDeLink(alvo)
        : await (async () => {
            if (!tab?.id) throw new Error('aba não identificada');
            const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: coletarDaPagina });
            return r?.result || { titulo: '', preco: null, precoDe: null, url: alvo };
          })();
      await chrome.windows.create({
        url: chrome.runtime.getURL('disparo.html') + '?linha=' + encodeURIComponent(montarLinha(d)),
        type: 'popup', width: 440, height: 680,
      });
      await pintarBadge();
      return;
    }

    let dados;
    if (info.menuItemId === 'tsp-rapido' && info.linkUrl) {
      // Sem abrir a pagina: o titulo fica para o painel resolver no cadastro,
      // exatamente como ja acontece quando voce cola um link puro.
      dados = { titulo: '', preco: null, precoDe: null, url: alvo };
    } else if (info.menuItemId === 'tsp-link' && info.linkUrl) {
      dados = await coletarDeLink(alvo);
    } else {
      if (!tab?.id) throw new Error('aba não identificada');
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: coletarDaPagina });
      dados = r?.result || { titulo: '', preco: null, precoDe: null, url: tab.url };
    }
    if (!dados.url || !/^https?:/i.test(dados.url)) throw new Error('link inválido');

    const fila = await lerFila();
    const chave = chaveDe(dados.url);
    if (fila.some(i => i.chave === chave)) {
      await pintarBadge(fila.length);
      avisar('Já está na fila', dados.titulo || dados.url);
      return;
    }
    fila.push({
      chave,
      linha: montarLinha(dados),
      titulo: dados.titulo || dados.url,
      em: Date.now(),
    });
    await gravarFila(fila);
    avisar('Guardado (' + fila.length + ' na fila)', dados.titulo || dados.url);
  } catch (e) {
    await pintarBadge();
    avisar('Não deu para guardar', String(e.message || e));
  }
});

// O painel pede a fila e avisa quando colou.
chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  if (msg?.tipo === 'fila') { lerFila().then(responder); return true; }
  if (msg?.tipo === 'limpar') { gravarFila([]).then(() => responder({ ok: true })); return true; }
  if (msg?.tipo === 'remover') {
    lerFila().then(f => gravarFila(f.filter(i => i.chave !== msg.chave)).then(() => responder({ ok: true })));
    return true;
  }
  return false;
});
