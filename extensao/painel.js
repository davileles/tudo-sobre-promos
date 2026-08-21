// ── Captura Tica — ponte com o painel ─────────────────────────────────────────
// Coloca um botao logo abaixo do campo "Links" da aba Vitrine. Ele despeja o
// que foi capturado no textarea e para por ai: cupom, modo de disparo e o
// cadastro em si continuam sendo escolha sua, com a lista inteira a vista.

const ID_BOTAO = 'tsp-captura-btn';
const ID_CAMPO = 'vit-links';

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

async function inserir(btn) {
  const campo = document.getElementById(ID_CAMPO);
  if (!campo) return;
  const fila = (await pedir({ tipo: 'fila' })) || [];
  if (!fila.length) return;

  // Nao repete o que ja esta digitado no campo: colar duas vezes por engano nao
  // pode virar produto duplicado na base.
  const jaTem = new Set(
    campo.value.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => (l.match(/https?:\/\/\S+/) || [''])[0])
  );
  const novas = fila
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

  await pedir({ tipo: 'limpar' });
  btn.dataset.avisando = '1';
  btn.textContent = novas.length
    ? '✓ ' + novas.length + ' inserido' + (novas.length > 1 ? 's' : '') + ' — defina o cupom e cadastre'
    : '✓ já estavam no campo';
  btn.disabled = true;
  btn.style.opacity = '.6';
  setTimeout(() => atualizarBotao(btn), 4000);
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
  if (area !== 'local' || !mud.fila) return;
  const btn = document.getElementById(ID_BOTAO);
  if (btn && btn.dataset.avisando !== '1') atualizarBotao(btn);
});
