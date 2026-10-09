# Captura Tica

Extensão do Chrome que junta links de produtos enquanto você navega e despeja
todos de uma vez no campo **Links** da aba Vitrine do painel — e que insere os
cupons do Mercado Livre na sua conta, no ritmo que o servidor manda (seção
*Cupons do Mercado Livre*).

**Ela não cadastra nada.** O cadastro continua sendo seu, no painel, com a lista
inteira à vista — é lá que você escolhe o cupom e o modo de disparo.

## Instalação

1. Descompacte numa pasta definitiva — o Chrome carrega da pasta original, então
   se ela for movida ou apagada a extensão para de funcionar.
2. `chrome://extensions` → ative **Modo do desenvolvedor**.
3. **Carregar sem compactação** → selecione a pasta `extensao`.
4. Fixe o ícone na barra: é nele que aparece quantos produtos estão na fila.

**Atualizando depois de um commit:** o Chrome não busca versão nova sozinho em
extensão sem compactação — ele lê a pasta do disco. Baixe os arquivos de novo
por cima e clique em ↻ **Atualizar** no cartão da extensão em
`chrome://extensions`. O rodapé do popup mostra a versão carregada; se ela não
bater com a do `manifest.json` no repositório, a pasta está velha.

## Fluxo

1. **Navegando:** botão direito num produto → *Guardar para a Vitrine TSP*.

   Os três itens do menu, e em que cada um age:

   | Item | Age sobre | Custo |
   |---|---|---|
   | Guardar **ESTA PÁGINA** | a página aberta no momento | instantâneo |
   | Guardar **O LINK** — lê o título | o link sob o cursor | ~2s (abre a página oculta) |
   | Guardar **O LINK** — instantâneo | o link sob o cursor | instantâneo |

   Os dois últimos só aparecem quando você clica com o botão direito em cima de
   um link. Em listagens o produto costuma ser uma imagem-link, e aí os três
   aparecem juntos — o primeiro guardaria a *página de resultados*, não o
   produto. Nesse caso use um dos dois de baixo.

   A diferença entre eles é só o título: o instantâneo deixa o painel resolver o
   nome no cadastro, igual a colar link puro. É o modo para varrer uma lista.
2. **Conferindo:** clique no ícone da extensão para ver a fila e remover o que
   não quer. O número no ícone é quantos estão guardados.
3. **Cadastrando:** abra `gestao.ticapromos.com.br` → aba 🏬 Vitrine e disparos.
   Abaixo do campo Links aparece **📥 Inserir N produtos capturados**. Clique,
   e as linhas caem no campo. A fila se esvazia, mas o lote fica guardado:
   se a página for recarregada antes do cadastro, o botão **↩ Reinserir último
   lote** devolve as linhas ao campo. O lote só é trocado no próximo despejo.
4. Dali em diante é o painel de sempre: escolhe o cupom, escolhe entre
   *Só cadastrar*, *Cadastrar e disparar agora* ou *Cadastrar como lista salva*.

A fila sobrevive a fechar o navegador. Links repetidos são ignorados, e o que já
estiver digitado no campo não é duplicado.

Links de resultado patrocinado (`/sspa/click?...`) são desembrulhados antes de
entrar na fila — sem isso, o que entraria era a URL do rastreador de anúncio, que
não vira produto nenhum.

## Disparo direto (sem montar lista)

Os itens **🚀 Disparar** abrem uma janela de confirmação em vez de mandar na hora:
ela cadastra o produto, mostra o nome resolvido e lista os **cupons vigentes
daquela loja** para você escolher. O envio só sai depois de um segundo `confirm`
com o resumo do que vai acontecer.

O produto continua entrando na base da vitrine — é inevitável, porque o disparo
trabalha com o ASIN e reconsulta preço e link de afiliado a partir do cadastro.
O que some é o trabalho manual: não há campo para colar, lista para montar nem
aba para navegar.

Desde a 2.8.0 a janela tem os **mesmos campos da aba "Criar oferta"** do painel:
gatilho, nome do produto, valor original (De), valor final sem cupom (Por), cupom
(melhor da base, escolher da base, **digitar à mão** com código, tipo e valor, ou
sem cupom) e IMPORTANTE. Nome, De e Por chegam preenchidos com o que a loja mostra;
só o que você muda vai para o servidor (`ajustes` na prévia, `ajustesItem` no
disparo), que monta a mensagem pelo template da loja com esses valores — na prévia
e de novo na hora do envio, com o link e o rastreio do momento. Campo intocado
continua sendo conferido na loja no envio.

Se você desistir, a janela oferece *deixar só cadastrado* ou *remover da base*.
Depois de disparar, aparece um botão para cancelar o que ainda não saiu.

**Isto é uma arma carregada.** Dois cliques separam um produto qualquer de uma
mensagem em todos os grupos, sem revisão de preço e sem prévia da mensagem. Para
qualquer coisa que não seja uma oferta óbvia e urgente, o caminho da fila é mais
seguro — lá você vê a lista inteira antes.

## Cupons do Mercado Livre (inserção na sua conta)

Desde 27/09/2026 quem insere os cupons do ML na conta TSP é **esta extensão**,
no seu Chrome. O servidor nunca mais toca a página do ML: a tentativa anterior
(chamadas a partir do Railway) tinha assinatura de robô — IP de datacenter, TLS
do Node com User-Agent de Chrome, POST sem navegação — e terminou com a conta
restrita em set/2026. Ritmo não esconde identidade; a identidade certa é a sua.

**Divisão de trabalho**

| Quem | Faz |
|---|---|
| `baileys-server` (`insercao-ml-auto.js`) | Fila, atraso pós-captura (5–40 min), lotes de 2–4 cupons por visita, pausa longa entre visitas (40–150 min, maior de manhã), janela 8h–23h, teto diário sorteado (6–14), dias de folga (10%), disjuntor, avisos no bot |
| Extensão (`cupons-ml.js`) | A cada 5 min pergunta ao servidor se há lote. Se houver, abre `mercadolivre.com.br/cupons` numa aba **em segundo plano**, clica em *Inserir código*, digita tecla a tecla, clica em *Inserir*, lê a resposta do ML e devolve o veredito. Fecha a aba ao terminar. Desde a 2.3.1 o service worker conduz **cupom a cupom** (uma injeção curta por cupom): se a página recarregar depois de uma inserção, a resposta sobrevive no `sessionStorage` da aba e a visita continua — antes o lote inteiro morria com "Frame with ID 0 was removed" e o service worker era derrubado pelo limite de 5 min do Chrome, o que também deixava o popup lento |

Você não precisa estar na página do ML nem clicar por cupom. Basta o Chrome
aberto (pode estar minimizado) com a sessão do ML logada neste perfil. Se o
Chrome estiver fechado, o cupom espera na fila; passando de 3 h parado, volta
para o `/inserir` do bot para você inserir do celular.

**Configuração (uma vez)**

1. No Railway (serviço `baileys-server`): `CUPONS_ML_INSERCAO_AUTO=1` e
   `CUPONS_ML_EXTENSAO_TOKEN=<uma senha longa qualquer>`.
2. No popup da extensão, seção **Cupons do Mercado Livre**: cole o mesmo token,
   escolha o modo e ligue o interruptor.

**Modos**

- *Perguntar antes de inserir* (padrão): quando há lote pronto, chega uma
  notificação do Chrome com os códigos e os botões **Inserir agora** / **Depois**.
  Um clique para o lote inteiro. "Depois" adia 30 min.
- *Automático*: insere sem perguntar. Recomendado só depois de duas semanas
  sem disjuntor no modo anterior.

**Vereditos que a extensão devolve**

`inserido`, `ja_tinha`, `esgotado`, `vencido`, `inexistente` vêm do
`response_code` da resposta do ML (capturada por um interceptor de `fetch` no
mundo da página e lida pelo DOM); o texto na tela é só reserva. `problema`
("Tivemos um problema"/HTTP 403) é o sintoma da restrição de conta: dois seguidos,
ou um com 403, abrem o disjuntor. `sem_login` e `pagina_mudou` (seletor não
encontrado) também desligam tudo e avisam no bot. Um erro qualquer encerra a
visita — insistir em seguida é assinatura de robô.

Os **seletores** da página vêm do servidor a cada lote (`SELETORES_PADRAO` em
`insercao-ml-auto.js`, sobrepostos por `CUPONS_ML_AUTO_SELETORES`): se o ML mudar
a página, corrige-se no servidor sem republicar a extensão.

Rotas usadas (todas com header `X-Extensao-Token`): `GET /cupons/auto/estado`,
`GET /cupons/auto/proximo[?espiar=1]`, `POST /cupons/auto/resultado`,
`POST /cupons/auto/visita/fim`.

## Aparência

A janela de disparo e o popup da fila usam as mesmas variáveis, tipografia e
componentes do painel (`tudo-sobre-promos/index.html`): fundo `#0f0f0f`, cartões
`#1a1a1a`, acento laranja, Montserrat, botões com as classes `.btn`/`.btn-copy`.

A fonte fica embutida em `fontes/montserrat.woff2` (38 KB, arquivo variável) em
vez de vir do Google Fonts — a extensão não deve depender de rede para renderizar.

O botão inserido no painel não tem estilo próprio: ele recebe as classes `.btn
btn-copy` da própria página, então acompanha o tema sozinho e não precisa ser
mantido em dois lugares.

## Lojas que funcionam

O painel só transforma em produto o link de:

- **Amazon**, **Mercado Livre**, **Shopee**, **Magazine Luiza** — nativas
- **~80 anunciantes via Awin** — Kabum, Carrefour, Centauro, Petz, Cobasi, Natura,
  Boticário, Riachuelo, C&A, Dafiti, Nike, Decathlon, Fast Shop, Vivara,
  Aliexpress, GOL, entre outros

A extensão consulta essa lista em `/awin/programas` uma vez por dia e recusa no
próprio clique o que não estiver nela — com o nome do domínio na notificação.
Sem isso o link entraria na fila e só seria negado lá no cadastro, depois de você
ter varrido a loja inteira.

Duas ausências que costumam surpreender: **Netshoes** e **Casas Bahia** não estão
na conta Awin. Se entrarem, a extensão passa a aceitá-las sozinha em até 24h —
não há lista fixa no código para atualizar.

Se o servidor estiver fora do ar, a extensão deixa passar em vez de bloquear:
travar a captura por indisponibilidade de rede seria pior que o problema original.

## Formato das linhas

| Loja | Linha gerada | Por quê |
|---|---|---|
| Amazon, Mercado Livre, Shopee | `Título \| URL` | O preço é reconsultado no disparo — preço de cadastro só envelheceria |
| Magazine Luiza, Awin, outras | `Título \| URL \| preço \| preço de` | Nessas o preço do cadastro é o plano B quando a loja bloqueia a leitura |

Exceção: na Magalu, título com dígito é omitido enquanto a correção de
`precosDaLinha` (`radar-magalu.js`) não estiver publicada no Railway — sem ela,
"Smart TV **50** polegadas" cadastraria o produto a R$ 50,00. Sem o título, o
nome sai do slug da URL, que já é legível.

## Se algo não funcionar

- **O botão não aparece no painel:** você precisa estar na aba Vitrine; o botão
  fica logo abaixo do campo Links. Se acabou de instalar, recarregue o painel.
- **Nada é guardado:** veja a notificação do Chrome — ela diz o motivo.
- **O domínio do painel mudou:** ajuste `matches` em `manifest.json` e `PAINEL`
  em `popup.js` — e **suba a versão** no `manifest.json` no mesmo commit. Foi o
  que faltou na migração `tudosobrepromos` → `ticapromos`: o `matches` novo foi
  commitado ainda como `2.0.1`, então a pasta instalada continuou casando só com
  o domínio antigo (hoje 404) e o botão sumiu do painel sem nenhum sinal de que
  a causa era build velho.
- **O botão sumiu depois de trocar de domínio:** compare a versão no rodapé do
  popup com a do `manifest.json` no repositório. Diferente = recarregue a pasta.
