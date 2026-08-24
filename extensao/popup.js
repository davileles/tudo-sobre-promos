const PAINEL = 'https://gestao.ticapromos.com.br/';

// Versao a vista: a extensao e carregada sem compactacao, entao a unica forma de
// saber se a pasta no disco e a mesma do repositorio e comparar aqui. Quando o
// dominio do painel mudou, o build antigo continuou marcado 2.0.1 e nao havia
// como perceber que o content script nao casava mais com a URL do painel.
const VERSAO = chrome.runtime.getManifest().version;

function pedir(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, resp => r(chrome.runtime.lastError ? null : resp)));
}

function loja(linha) {
  const m = linha.match(/https?:\/\/([^\/\s]+)/);
  return m ? m[1].replace(/^www\./, '') : '';
}

async function pintar() {
  const fila = (await pedir({ tipo: 'fila' })) || [];
  const lista = document.getElementById('lista');
  const sub = document.getElementById('sub');
  lista.innerHTML = '';

  if (!fila.length) {
    sub.textContent = 'Fila vazia';
    lista.innerHTML = '<li><div class="vazio">Botão direito num produto (ou no link dele) '
      + 'para guardar aqui. Depois abra o painel e clique em <b>Inserir capturados</b> '
      + 'abaixo do campo Links.</div></li>';
    return;
  }

  sub.textContent = fila.length + ' produto' + (fila.length > 1 ? 's' : '') + ' aguardando';
  for (const item of fila) {
    const li = document.createElement('li');
    const div = document.createElement('div');
    div.className = 'nome';
    div.textContent = item.titulo || item.chave;
    const sm = document.createElement('div');
    sm.className = 'loja';
    sm.textContent = loja(item.linha);
    div.appendChild(sm);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Remover da fila';
    x.addEventListener('click', async () => { await pedir({ tipo: 'remover', chave: item.chave }); pintar(); });
    li.appendChild(div);
    li.appendChild(x);
    lista.appendChild(li);
  }
}

document.getElementById('abrir').addEventListener('click', async () => {
  const abas = await chrome.tabs.query({ url: PAINEL + '*' });
  if (abas.length) await chrome.tabs.update(abas[0].id, { active: true });
  else await chrome.tabs.create({ url: PAINEL });
  window.close();
});

document.getElementById('limpar').addEventListener('click', async () => {
  await pedir({ tipo: 'limpar' });
  pintar();
});

document.getElementById('versao').textContent = VERSAO;
document.getElementById('dominio').textContent = new URL(PAINEL).hostname;

pintar();
