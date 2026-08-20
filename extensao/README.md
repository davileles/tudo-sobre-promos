# Captura TSP

Extensão do Chrome que junta links de produtos enquanto você navega e despeja
todos de uma vez no campo **Links** da aba Vitrine do painel.

**Ela não cadastra nada.** O cadastro continua sendo seu, no painel, com a lista
inteira à vista — é lá que você escolhe o cupom e o modo de disparo.

## Instalação

1. Descompacte numa pasta definitiva — o Chrome carrega da pasta original, então
   se ela for movida ou apagada a extensão para de funcionar.
2. `chrome://extensions` → ative **Modo do desenvolvedor**.
3. **Carregar sem compactação** → selecione a pasta `cdv-captura`.
4. Fixe o ícone na barra: é nele que aparece quantos produtos estão na fila.

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
3. **Cadastrando:** abra `gestao.tudosobrepromos.com` → aba 🏬 Vitrine e disparos.
   Abaixo do campo Links aparece **📥 Inserir N produtos capturados**. Clique,
   e as linhas caem no campo. A fila se esvazia.
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

Se você desistir, a janela oferece *deixar só cadastrado* ou *remover da base*.
Depois de disparar, aparece um botão para cancelar o que ainda não saiu.

**Isto é uma arma carregada.** Dois cliques separam um produto qualquer de uma
mensagem em todos os grupos, sem revisão de preço e sem prévia da mensagem. Para
qualquer coisa que não seja uma oferta óbvia e urgente, o caminho da fila é mais
seguro — lá você vê a lista inteira antes.

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
  em `popup.js`.
