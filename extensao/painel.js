// ── Captura Tica — ponte com o painel ─────────────────────────────────────────
// Coloca um botao logo abaixo do campo "Links" da aba Vitrine. Ele despeja o
// que foi capturado no textarea e para por ai: cupom, modo de disparo e o
// cadastro em si continuam sendo escolha sua, com a lista inteira a vista.

const ID_BOTAO = 'tsp-captura-btn';
const ID_CAMPO = 'vit-links';
const ID_REINSERIR = 'tsp-captura-reinserir';

function pedir(msg) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(chrome.runtime.lastError ? null : r)); }
    catch (_) { resolve(null); }
  });
}

// Usa as classes do proprio painel em vez de estilo proprio: assim o botao
// acompanha tema, fonte e paleta sem precisar ser mantido em dois lugares.
function estilizar(btn) {
  btn.className = 'btn btn-copy';
  btn.style.cssText = 'margin-top:8px;font-size:12px;padding:10px';
}

async function atualizarBotao(btn) {
  const fila = (await pedir({ tipo: 'fila' })) || [];
  btn.dataset.avisando = '0';
  btn.dataset.qtd = String(fila.length);
  if (!fila.length) {
    btn.textContent = 'Nenhum produto capturado';
    btn.disabled = true;
    btn.style.opacity = '.45';
    btn.style.cursor = 'default';
  } else {
    btn.textContent = '📥 Inserir ' + fila.length + ' produto' + (fila.length > 1 ? 's' : '') + ' capturado' + (fila.length > 1 ? 's' : '');
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

// Poe as linhas no campo sem repetir o que ja esta digitado: colar duas vezes
// por engano nao pode virar produto duplicado na base. Devolve quantas entraram.
function despejarNoCampo(campo, itens) {
  const jaTem = new Set(
    campo.value.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => (l.match(/https?:\/\/\S+/) || [''])[0])
  );
  const novas = itens
    .filter(i => !jaTem.has((i.linha.match(/https?:\/\/\S+/) || [''])[0]))
    .map(i => i.linha);

  if (novas.length) {
    const atual = campo.value.replace(/\s+$/, '');
    campo.value = (atual ? atual + '\n' : '') + novas.join('\n') + '\n';
    // O painel escuta 'input' para habilitar os botoes de cadastro.
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    campo.focus();
    campo.setSelectionRange(campo.value.length, campo.value.length);
  }
  return novas;
}

async function inserir(btn) {
  const campo = document.getElementById(ID_CAMPO);
  if (!campo) return;
  const fila = (await pedir({ tipo: 'fila' })) || [];
  if (!fila.length) return;

  const novas = despejarNoCampo(campo, fila);

  // 'despejar' esvazia a fila mas guarda o lote — um refresh antes de
  // cadastrar nao perde mais os produtos.
  await pedir({ tipo: 'despejar' });
  atualizarReinserir();
  btn.dataset.avisando = '1';
  btn.textContent = novas.length
    ? '✓ ' + novas.length + ' inserido' + (novas.length > 1 ? 's' : '') + ' — defina o cupom e cadastre'
    : '✓ já estavam no campo';
  btn.disabled = true;
  btn.style.opacity = '.6';
  setTimeout(() => atualizarBotao(btn), 4000);
}

// ── Reinserir o ultimo lote ──
// Rede de seguranca para o refresh acidental: o lote despejado por ultimo fica
// guardado na extensao ate o proximo despejo e pode voltar ao campo quantas
// vezes for preciso. O servidor nao duplica produto, entao reinserir algo que
// ja foi cadastrado so atualiza o registro.
async function atualizarReinserir() {
  const btn = document.getElementById(ID_REINSERIR);
  if (!btn) return;
  const lote = await pedir({ tipo: 'ultimoLote' });
  const n = lote?.itens?.length || 0;
  if (!n) { btn.style.display = 'none'; return; }
  const quando = new Date(lote.em).toLocaleString('pt-BR',
    { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  btn.textContent = '↩ Reinserir último lote (' + n + ' produto' + (n > 1 ? 's' : '') + ' · ' + quando + ')';
  btn.style.display = '';
  btn.disabled = false;
  btn.style.opacity = '1';
}

async function reinserir(btn) {
  const campo = document.getElementById(ID_CAMPO);
  const lote = await pedir({ tipo: 'ultimoLote' });
  if (!campo || !lote?.itens?.length) return;
  const novas = despejarNoCampo(campo, lote.itens);
  btn.textContent = novas.length
    ? '✓ ' + novas.length + ' reinserido' + (novas.length > 1 ? 's' : '') + ' — defina o cupom e cadastre'
    : '✓ já estavam no campo';
  btn.disabled = true;
  btn.style.opacity = '.6';
  setTimeout(atualizarReinserir, 4000);
}

function montar() {
  const campo = document.getElementById(ID_CAMPO);
  if (!campo || document.getElementById(ID_BOTAO)) return;
  const btn = document.createElement('button');
  btn.id = ID_BOTAO;
  btn.type = 'button';
  estilizar(btn);
  btn.addEventListener('click', () => inserir(btn));
  campo.insertAdjacentElement('afterend', btn);
  atualizarBotao(btn);

  const re = document.createElement('button');
  re.id = ID_REINSERIR;
  re.type = 'button';
  estilizar(re);
  re.style.display = 'none';
  re.addEventListener('click', () => reinserir(re));
  btn.insertAdjacentElement('afterend', re);
  atualizarReinserir();
}

// O painel troca de aba sem recarregar a pagina, entao o campo pode aparecer
// depois. Observar o DOM cobre isso sem ficar em polling eterno.
const obs = new MutationObserver(() => montar());
obs.observe(document.documentElement, { childList: true, subtree: true });
montar();

// Capturou em outra janela com o painel aberto: o contador acompanha sozinho,
// sem refresh. Nao mexe durante os 4s do aviso "inserido", para nao apagar a
// confirmacao que voce acabou de ver.
chrome.storage.onChanged.addListener((mud, area) => {
  if (area !== 'local') return;
  if (mud.ultimoLote) atualizarReinserir();
  if (!mud.fila) return;
  const btn = document.getElementById(ID_BOTAO);
  if (btn && btn.dataset.avisando !== '1') atualizarBotao(btn);
});
