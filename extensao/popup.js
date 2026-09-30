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


// ── Cupons do Mercado Livre (inserção pela extensão) ─────────────────────────
const mlEl = id => document.getElementById(id);

async function mlPintar() {
  const cfg = await pedir({ tipo: 'ml-cfg' });
  if (!cfg) return;
  mlEl('ml-ligado').checked = !!cfg.ligado;
  mlEl('ml-modo').value = cfg.modo || 'aprovar';
  mlEl('ml-token').value = cfg.token || '';
  const st = mlEl('ml-status');
  if (!cfg.token) { st.innerHTML = 'Cole aqui o mesmo valor de <b>CUPONS_ML_EXTENSAO_TOKEN</b> do Railway e salve.'; return; }
  if (!cfg.ligado) { st.textContent = 'Desligada. Ligue no interruptor para a fila andar.'; return; }
  st.textContent = 'Consultando o servidor…';
  const e = await pedir({ tipo: 'ml-estado' });
  if (!e) { st.textContent = 'Sem resposta da extensão.'; return; }
  const s = e.servidor || {};
  const partes = [];
  if (!s.ok) partes.push('<span class="ruim">Servidor: ' + (s.erro || 'sem resposta') + '</span>');
  else {
    if (!s.ligada) partes.push('<span class="ruim">Servidor com a fila desligada (CUPONS_ML_INSERCAO_AUTO)</span>');
    else if (s.disjuntor) partes.push('<span class="ruim">Disjuntor: ' + (s.disjuntor.motivo || '') + '</span>');
    else partes.push('<span class="ok">Ligada</span> · hoje <b>' + s.feitasHoje + '/' + s.tetoDia + '</b>' + (s.folgaHoje ? ' · dia de folga' : '')
      + (s.dentroDaJanela ? '' : ' · fora do horário'));
    partes.push('Na fila: <b>' + (s.naFila || []).length + '</b>' + ((s.naFila || []).length ? ' — ' + s.naFila.slice(0, 6).join(', ') : '')
      + ((s.emVisita || []).length ? '<br>Inserindo agora: ' + s.emVisita.join(', ') : '')
      + (s.proximaEm && s.proximaEm > Date.now() ? '<br>Próxima visita: ~' + s.proximaHora : ''));
  }
  if (s.ok && s.leitura) {
    const l = s.leitura, u = l.ultimo;
    const hora = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    if (!l.ligada) partes.push('Validade: leitura desligada no servidor (CUPONS_ML_LEITURA)');
    else if (u && u.ok) partes.push('Validade lida às <b>' + hora(u.em) + '</b> · ' + u.naPagina + ' cupons na conta');
    else if (u) partes.push('<span class="ruim">Validade: ' + String(u.erro || 'falhou').replace(/</g, '&lt;') + '</span>');
    else partes.push('Validade: ainda não lida');
  }
  if (e.ultimo) partes.push('Último: ' + e.ultimo.texto.replace(/</g, '&lt;'));
  st.innerHTML = partes.join('<br>');
}

mlEl('ml-salvar').addEventListener('click', async () => {
  await pedir({ tipo: 'ml-salvar', cfg: { ligado: mlEl('ml-ligado').checked, modo: mlEl('ml-modo').value, token: mlEl('ml-token').value } });
  mlPintar();
});
mlEl('ml-ligado').addEventListener('change', async () => {
  await pedir({ tipo: 'ml-salvar', cfg: { ligado: mlEl('ml-ligado').checked } });
  mlPintar();
});
mlEl('ml-agora').addEventListener('click', async () => {
  mlEl('ml-status').textContent = 'Verificando…';
  await pedir({ tipo: 'ml-agora' });
  mlPintar();
});

mlPintar();
