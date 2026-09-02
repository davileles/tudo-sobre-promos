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
      // Restritos vão para o fim: o topo da lista é o que o operador escolhe no
      // automático, e cupom de seleção fechada nunca deve ser o padrão visual.
      .sort((a, b) => ((a.restrito === true) - (b.restrito === true))
                   || ((b.valor || 0) - (a.valor || 0)));

    sel.innerHTML = '';
    if (!daLoja.length) {
      sel.innerHTML = '<option value="">nenhum cupom vigente para ' + (loja || 'esta loja') + '</option>';
      $('hintCupom').textContent = 'Sem cupom cadastrado para esta loja — use "melhor cupom" ou "sem cupom".';
      return;
    }
    for (const c of daLoja) {
      const o = document.createElement('option');
      o.value = c.codigo;
      o.textContent = descreveCupom(c);
      sel.appendChild(o);
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
});

// ── 3. DISPARO ────────────────────────────────────────────────────────────────
$('disparar').addEventListener('click', async () => {
  if (!ITEM) return;
  const modo = $('modo').value;
  const codigo = modo === 'fixo' ? $('cupom').value : null;
  if (modo === 'fixo' && !codigo) { estado('Escolha o cupom ou troque o modo.', 'err'); return; }
  const hora = $('hora').value || null;

  const resumo = 'Disparar agora para os grupos:\n\n'
    + (ITEM.nome || ITEM.asin) + '\n'
    + 'Loja: ' + (ITEM.loja || '?') + '\n'
    + 'Cupom: ' + (modo === 'fixo' ? codigo : modo === 'auto' ? 'melhor disponível' : 'nenhum') + '\n'
    + 'Início: ' + (hora || 'imediato') + '\n\n'
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
