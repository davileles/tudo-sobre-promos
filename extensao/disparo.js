// ── Disparo direto ────────────────────────────────────────────────────────────
// Cadastra o produto na base (inevitavel: o disparo trabalha com o ASIN e
// reconsulta preco e link a partir do cadastro) e oferece os cupons vigentes da
// loja. O envio so acontece com confirmacao explicita — mensagem em grupo nao
// tem desfazer.

const SERVIDOR = 'https://baileys-server-production-ebfe.up.railway.app';
const params = new URLSearchParams(location.search);
const LINHA = params.get('linha') || '';

let ITEM = null;      // { asin, nome, loja }
let LISTA_ID = null;  // id da lista efemera, para o cancelamento

const $ = id => document.getElementById(id);
const estado = (txt, tipo) => {
  $('estado').textContent = txt;
  $('estado').className = 'send-ok' + (tipo === 'err' ? ' send-err' : tipo === 'ok' ? '' : ' neutro');
};

// "Aliexpress BR & LATAM" e "Aliexpress" precisam bater; a base de cupons e o
// cadastro nomeiam a mesma loja de formas diferentes.
const REGIAO = new Set(['br', 'bra', 'brasil', 'brazil', 'latam', 'global', 'com', 'loja', 'store', 'oficial']);
function chaveLoja(nome) {
  return String(nome || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^outr[oa]s?\s*:\s*/, '')
    .split(/[^a-z0-9]+/).filter(t => t && !REGIAO.has(t)).join('');
}

function descreveCupom(c) {
  const v = c.tipo === 'pct' ? c.valor + '%' : 'R$ ' + c.valor;
  const min = c.minimo ? ' · mín. R$ ' + c.minimo : '';
  // 🎯 = cupom restrito: só vale na seleção fechada de produtos combinada com a
  // loja. Escolher aqui é vinculação explícita e continua permitido — o alerta
  // existe para o operador não colar o código num item que não está na lista.
  const res = c.restrito === true ? '🎯 ' : '';
  return res + c.codigo + ' — ' + v + min + (c.restrito === true ? ' · só produtos específicos' : '');
}

// ── 1. CADASTRO ───────────────────────────────────────────────────────────────
async function cadastrar() {
  if (!LINHA) { estado('Nada recebido para cadastrar.', 'err'); return; }
  try {
    const r = await fetch(SERVIDOR + '/vitrine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: LINHA }),
    });
    const d = await r.json();
    const salvo = (d.salvos || [])[0];
    if (!salvo) {
      const erro = (d.erros || [])[0];
      $('nome').textContent = 'Não deu para cadastrar';
      $('meta').textContent = (erro && erro.erro) || 'o servidor não reconheceu o link';
      estado('Corrija o link e tente de novo.', 'err');
      return;
    }
    ITEM = salvo;
    $('nome').textContent = salvo.nome || salvo.asin;
    $('meta').innerHTML = '<span class="loja"></span> · <span class="asin"></span>'
      + (salvo.jaExistia ? ' · já estava na base' : ' · novo na base');
    $('meta').querySelector('.loja').textContent = salvo.loja || '—';
    $('meta').querySelector('.asin').textContent = salvo.asin;
    $('form').classList.remove('some');
    carregarCupons(salvo.loja);
    carregarPrevia();
  } catch (e) {
    estado('Erro ao cadastrar: ' + e.message, 'err');
  }
}

// ── 2. CUPONS DA LOJA ─────────────────────────────────────────────────────────
async function carregarCupons(loja) {
  const sel = $('cupom');
  sel.innerHTML = '<option value="">carregando…</option>';
  try {
    const r = await fetch(SERVIDOR + '/cupons/base?t=' + Date.now(), { cache: 'no-cache' });
    const d = await r.json();
    const agora = Date.now();
    const chave = chaveLoja(loja);
    const daLoja = (d.itens || [])
      .filter(c => c.ativo !== false)
      .filter(c => !c.validadeAte || new Date(c.validadeAte).getTime() > agora)
      .filter(c => chaveLoja(c.loja) === chave)
      // Agrupado por loja e em ordem alfabética (loja A→Z, código A→Z), como em
      // todo select de cupom do ecossistema.
      .sort((a, b) => String(a.loja || '').localeCompare(String(b.loja || ''), 'pt-BR', { sensitivity: 'base' })
                   || String(a.codigo || '').localeCompare(String(b.codigo || ''), 'pt-BR', { numeric: true, sensitivity: 'base' }));

    sel.innerHTML = '';
    if (!daLoja.length) {
      sel.innerHTML = '<option value="">nenhum cupom vigente para ' + (loja || 'esta loja') + '</option>';
      $('hintCupom').textContent = 'Sem cupom cadastrado para esta loja — use "melhor cupom" ou "sem cupom".';
      return;
    }
    const grupos = new Map();
    for (const c of daLoja) {
      const k = chaveLoja(c.loja);
      if (!grupos.has(k)) {
        const g = document.createElement('optgroup');
        g.label = c.loja || loja || 'Outros';
        grupos.set(k, g);
        sel.appendChild(g);
      }
      const o = document.createElement('option');
      o.value = c.codigo;
      o.textContent = descreveCupom(c);
      grupos.get(k).appendChild(o);
    }
    const nRes = daLoja.filter(c => c.restrito === true).length;
    $('hintCupom').textContent = daLoja.length + ' cupom(ns) vigente(s) para ' + loja + '.'
      + (nRes ? ' ' + nRes + ' restrito(s) 🎯 — confira se este produto está na seleção.' : '');
  } catch (e) {
    sel.innerHTML = '<option value="">falha ao carregar</option>';
    $('hintCupom').textContent = 'Não deu para ler a base de cupons: ' + e.message;
  }
}

$('modo').addEventListener('change', () => {
  $('wrapCupom').classList.toggle('some', $('modo').value !== 'fixo');
  $('wrapManual').classList.toggle('some', $('modo').value !== 'manual');
  carregarPrevia();
});
$('cupom').addEventListener('change', () => carregarPrevia());

// ── 2a. CAMPOS DA OFERTA ──────────────────────────────────────────────────────
// Os mesmos campos da aba "Criar oferta" do painel. Nome, De e Por chegam
// preenchidos com o que a loja mostra agora; só vai para o servidor o que o
// operador mudou (campo intocado = o servidor confere de novo no envio).
// Cupom digitado à mão: o servidor monta sem cupom da base e escreve este.
let ORIG = null;          // { nome, de, por } da primeira prévia

const valNum = id => { const v = parseFloat(String($(id).value).replace(',', '.')); return Number.isFinite(v) && v > 0 ? v : null; };
const fix2 = v => v == null ? '' : Number(v).toFixed(2);

function modoServidor() {
  const m = $('modo').value;
  return m === 'manual' ? 'nenhum' : m;
}

function ajustesOferta() {
  const a = {};
  const gat = $('fGatilho').value.trim(); if (gat) a.gatilho = gat;
  const imp = $('fImportante').value.trim(); if (imp) a.importante = imp;
  const nome = $('fNome').value.trim();
  if (nome && (!ORIG || nome !== ORIG.nome)) a.nome = nome;
  const de = valNum('fDe'), por = valNum('fPor');
  if (de && (!ORIG || fix2(de) !== fix2(ORIG.de))) a.precoDe = de;
  if (por && (!ORIG || fix2(por) !== fix2(ORIG.por))) a.preco = por;
  if ($('modo').value === 'manual') {
    const codigo = $('fCupom').value.trim().toUpperCase();
    if (codigo) a.cupom = { codigo, tipo: $('fTipo').value, valor: valNum('fCupomValor') };
  }
  return Object.keys(a).length ? a : null;
}

let _tCampos = null;
function camposMudaram() {
  clearTimeout(_tCampos);
  _tCampos = setTimeout(() => carregarPrevia(), 600);
}
['fGatilho', 'fNome', 'fDe', 'fPor', 'fCupom', 'fCupomValor', 'fImportante']
  .forEach(id => $(id).addEventListener('input', camposMudaram));
$('fTipo').addEventListener('change', camposMudaram);

// ── 2b. PRÉVIA E EDIÇÃO ───────────────────────────────────────────────────────
// O servidor monta o texto exatamente como o disparo montaria (mesmo cupom).
// O operador pode trocar o nome e mexer no texto; a edição vai junto no
// disparo (edicoesItem) e o servidor troca só os links pelos do momento do envio.
let PREVIA = null;        // resposta de /listas/disparo-unico/previa
let PREVIA_SEQ = 0;

const RE_URL = /https?:\/\/[^\s`"'<>]+/g;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Formatação do WhatsApp para a bolha: *negrito*, _itálico_, ~riscado~, ```mono```.
function formatarWa(t) {
  // Links saem antes da formatação: _ e * dentro de URL não podem virar estilo.
  const links = [];
  let h = escHtml(t).replace(/https?:\/\/[^\s<]+/g, u => { links.push(u); return '\u0000' + (links.length - 1) + '\u0000'; });
  h = h.replace(/```([\s\S]+?)```/g, '<code>$1</code>')
       .replace(/`([^`\n]+)`/g, '<code>$1</code>')
       .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<b>$2</b>')
       .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
       .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/g, '$1<s>$2</s>')
;
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => '<a>' + links[+i] + '</a>');
}

function editado() {
  if (!PREVIA) return false;
  return $('textoEd').value.trim() !== String(PREVIA.mensagem || '').trim();
}

function renderBolha() {
  const img = PREVIA && PREVIA.imagemUrl
    ? '<img src="' + escHtml(PREVIA.imagemUrl) + '" alt="">' : '';
  $('bolha').innerHTML = img + '<div class="wa-txt">' + formatarWa($('textoEd').value) + '</div>';
  $('seloEd').classList.toggle('some', !editado());
}

async function carregarPrevia() {
  if (!ITEM) return;
  const seq = ++PREVIA_SEQ;
  const modo = modoServidor();
  const codigo = modo === 'fixo' ? $('cupom').value : null;
  if (modo === 'fixo' && !codigo) return;
  if (editado() && !confirm('Atualizar a prévia descarta o que você editou no texto. Continuar?')) return;
  $('hintPrevia').textContent = 'Montando a prévia…';
  try {
    const r = await fetch(SERVIDOR + '/listas/disparo-unico/previa', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asin: ITEM.asin, cupomModo: modo, cupomCodigo: codigo,
                             ajustes: ORIG ? ajustesOferta() : null }),
    });
    const d = await r.json();
    if (seq !== PREVIA_SEQ) return;          // outra prévia mais nova já foi pedida
    if (!d.ok) {
      PREVIA = null;
      $('bolha').innerHTML = '<div class="wa-txt">Sem prévia.</div>';
      $('hintPrevia').textContent = 'Não deu para montar a prévia: ' + (d.erro || 'erro')
        + '. O disparo ainda tenta montar na hora do envio.';
      $('textoEd').value = '';
      return;
    }
    PREVIA = d;
    if (!ORIG) {
      // Primeira prévia: o que a loja mostra agora vira o valor inicial dos campos.
      ORIG = { nome: String(d.titulo || d.nome || ITEM.nome || '').trim(),
               de: d.precoDe != null ? Number(d.precoDe) : null,
               por: d.preco != null ? Number(d.preco) : null };
      if (!$('fNome').value.trim()) $('fNome').value = ORIG.nome;
      if (!$('fDe').value) $('fDe').value = fix2(ORIG.de);
      if (!$('fPor').value) $('fPor').value = fix2(ORIG.por);
    }
    $('textoEd').value = String(d.mensagem || '');
    renderBolha();
    const preco = v => v == null ? '?' : 'R$ ' + Number(v).toFixed(2).replace('.', ',');
    $('hintPrevia').textContent = 'Preço de agora: ' + preco(d.preco)
      + (d.cupom ? ' · com ' + d.cupom + ': ' + preco(d.precoFinal) : '')
      + (d.avisoCupom ? ' · ⚠️ ' + d.avisoCupom : '');
  } catch (e) {
    if (seq !== PREVIA_SEQ) return;
    $('hintPrevia').textContent = 'Não deu para montar a prévia: ' + e.message;
  }
}

$('textoEd').addEventListener('input', renderBolha);
$('desfazerEd').addEventListener('click', () => {
  if (!PREVIA) return;
  $('textoEd').value = PREVIA.mensagem || '';
  renderBolha();
});
$('atualizarPrevia').addEventListener('click', () => carregarPrevia());

// Edição que vai junto no disparo (null = sem edição: sai o texto do servidor).
function edicaoParaEnvio() {
  if (!PREVIA || !editado()) return null;
  return {
    texto: $('textoEd').value,
    nome: '',
    nomeOriginal: '',
    precoFinal: PREVIA.precoFinal,
    cupom: PREVIA.cupom,
  };
}

// ── 3. DISPARO ────────────────────────────────────────────────────────────────
$('disparar').addEventListener('click', async () => {
  if (!ITEM) return;
  const modoTela = $('modo').value;
  const modo = modoServidor();
  const codigo = modo === 'fixo' ? $('cupom').value : null;
  if (modo === 'fixo' && !codigo) { estado('Escolha o cupom ou troque o modo.', 'err'); return; }
  if (modoTela === 'manual' && !$('fCupom').value.trim()) { estado('Digite o código do cupom ou troque o modo.', 'err'); return; }
  if (ORIG && !$('fNome').value.trim()) { estado('Preencha o nome do produto.', 'err'); return; }
  const hora = $('hora').value || null;
  const aj = ajustesOferta();

  const ed = edicaoParaEnvio();
  if (ed) {
    const tinhaLink = (String(PREVIA.mensagem || '').match(RE_URL) || []).length;
    if (tinhaLink && !(ed.texto.match(RE_URL) || []).length) {
      estado('O texto editado ficou sem o link do produto. Recoloque o link ou volte ao original.', 'err');
      return;
    }
    if (!ed.texto.trim()) { estado('O texto da mensagem está vazio.', 'err'); return; }
  }

  const resumo = 'Disparar agora para os grupos:\n\n'
    + ($('fNome').value.trim() || ITEM.nome || ITEM.asin) + '\n'
    + 'Loja: ' + (ITEM.loja || '?') + '\n'
    + 'Cupom: ' + (modoTela === 'manual' ? $('fCupom').value.trim().toUpperCase() + ' (digitado)'
                   : modo === 'fixo' ? codigo : modo === 'auto' ? 'melhor disponível' : 'nenhum') + '\n'
    + (aj && (aj.preco || aj.precoDe) ? 'Valores: digitados por você\n' : '')
    + 'Início: ' + (hora || 'imediato') + '\n'
    + 'Texto: ' + (ed ? 'editado por você' : 'original') + '\n\n'
    + 'Não há desfazer depois que a mensagem sai.';
  if (!confirm(resumo)) return;

  $('disparar').disabled = true;
  estado('Abrindo a fila…');
  try {
    const r = await fetch(SERVIDOR + '/listas/disparo-unico', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        produtos: [ITEM.asin],
        cupomModo: modo,
        cupomCodigo: codigo,
        iniciarHora: hora,
        edicoesItem: ed ? { [ITEM.asin]: ed } : undefined,
        ajustesItem: aj ? { [ITEM.asin]: aj } : undefined,
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.erro || 'falhou');
    LISTA_ID = d.lista && d.lista.id;
    estado(d.aguardando
      ? '✓ Agendado para ' + (d.iniciaAs || hora) + '.'
      : '✓ Disparo iniciado.', 'ok');
    $('form').classList.add('some');
    if (LISTA_ID) $('cancelar').classList.remove('some');
  } catch (e) {
    $('disparar').disabled = false;
    estado('Erro: ' + e.message, 'err');
  }
});

// ── 4. SAÍDAS ─────────────────────────────────────────────────────────────────
$('cancelar').addEventListener('click', async () => {
  if (!LISTA_ID) return;
  try {
    const r = await fetch(SERVIDOR + '/listas/' + LISTA_ID + '/cancelar', { method: 'POST' });
    const d = await r.json();
    estado(d.ok ? '✓ Cancelado o que ainda não tinha saído.' : 'Não deu para cancelar: ' + (d.erro || ''),
           d.ok ? 'ok' : 'err');
    $('cancelar').classList.add('some');
  } catch (e) { estado('Erro ao cancelar: ' + e.message, 'err'); }
});

$('sair').addEventListener('click', () => window.close());

$('remover').addEventListener('click', async () => {
  if (!ITEM) { window.close(); return; }
  if (!confirm('Remover "' + (ITEM.nome || ITEM.asin) + '" da base da vitrine?')) return;
  try { await fetch(SERVIDOR + '/vitrine/' + encodeURIComponent(ITEM.asin), { method: 'DELETE' }); }
  catch (_) { /* fechar mesmo assim: o item fica na base e some pelo painel */ }
  window.close();
});

cadastrar();
