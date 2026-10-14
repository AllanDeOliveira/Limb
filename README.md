# Limb

Chat de texto e voz com compartilhamento de tela, feito para você e seus amigos. Não depende de nenhuma
empresa: o servidor roda no computador de um de vocês (ou numa VPS), e os dados ficam com vocês.

> Projeto independente, sem relação com a Discord Inc. Inspirado na arquitetura do Discord;
> nenhum código do Discord é usado.

## O que tem

- **Servidores e canais** de texto e de voz
- **Mensagens** com markdown (`**negrito**`, `*itálico*`, `` `código` ``, `||spoiler||`, links), respostas,
  reações, edição, @menções e contador de não lidas
- **Busca** no estilo do Discord: `from:ana has:link before:2026-10-01 in:geral palavra`
- **Voz** com indicador de quem está falando, mudo, surdo, volume de cada pessoa (até 200%), volume geral,
  qualidade da voz (32 a 128 kbps), supressão de ruído e cancelamento de eco
- **Microfone automático**, como no Discord: se o escolhido está ocupado ou é desconectado no meio da
  chamada, o Limb passa para outro (o do notebook) sem sair da chamada e volta quando ele reaparece; no
  "Padrão do sistema", segue o padrão do Windows. Em **Voz e áudio**, **Testar microfone** mostra o volume
  da sua voz e a marca a partir da qual os outros veem você falando
- **Sons da chamada** (entrar, sair, alguém entrou ou saiu, mudo, surdo, transmissão, menção, queda),
  gerados pelo próprio app, com volume e categorias em **Voz e áudio → Sons**
- **Compartilhar tela** como o "Go Live": 480p a 1440p ou Original, 15/30/60 fps, otimizar para nitidez
  (texto) ou movimento (jogos) e codec (H.264, VP9, AV1) em Avançado; o som do computador vai junto no
  Windows. A tela só é enviada para quem clica em **AO VIVO**, e o painel mostra quantos estão assistindo
- **App para Windows** com notificações de menção e o servidor embutido; também funciona no navegador
- **Contas** com **Entrar** e **Criar conta** separados, convite por link (como o `discord.gg/…`: ninguém
  digita código) e uma sessão por aparelho (vale 30 dias sem uso). Em **Minha conta** (ícone de pessoa ao
  lado do seu nome) dá para trocar a senha, ver os dispositivos conectados e desconectar qualquer um. Senhas novas: 8 a 128 caracteres, sem o
  nome de usuário e nada óbvio; 5 senhas erradas seguidas travam a conta por 1 minuto (dobrando até 15)

## Instalar (Windows)

**Pelo terminal** — abra o PowerShell e cole:

```powershell
irm https://raw.githubusercontent.com/AllanDeOliveira/Limb/main/install.ps1 | iex
```

Baixa a última versão, instala para o seu usuário (não pede administrador) e abre o app.

**Ou baixe** em [Releases](https://github.com/AllanDeOliveira/Limb/releases/latest):

- `Limb-x.y.z-instalador.exe` — **recomendado**: instala e **se atualiza sozinho**.
- `Limb-x.y.z-portatil.exe` — roda sem instalar; avisa quando sai versão nova, mas a troca é manual.

O Windows pode mostrar um aviso do SmartScreen, porque o executável não tem assinatura digital:
clique em **Mais informações → Executar assim mesmo**.

Ao abrir pela primeira vez, o app pergunta se você vai **hospedar** ou **entrar** no servidor de um amigo
(veja [Jogar com os amigos](#jogar-com-os-amigos)). Depois, em **Criar conta**, escolha um nome e uma senha.
Num servidor novo, a primeira conta é a do dono e não precisa de convite, se criada no próprio computador
que hospeda (o app ou um navegador em `localhost`); as seguintes, só com o link. Abrindo o seu próprio
`https://….ts.net` no navegador antes disso, a tela avisa "Servidor novo": crie a conta no app, ou abra o link
de convite (**Servidor → Copiar convite**).
Recebeu um link de convite (`https://….ts.net/convite/…`)? Abra o link: ele leva ao download, e o app
encontra o convite sozinho.

## Atualizar

- **Instalador:** automático. O app procura versão nova ao abrir e a cada 6 horas, baixa em segundo plano
  e pergunta se pode reiniciar (se você disser "Depois", instala quando fechar).
- **Pelo terminal:** o mesmo comando da instalação. Se já estiver na última versão, ele avisa e não faz nada.
- **Portátil:** o app avisa e abre a página de download.

A interface vem do servidor de quem hospeda: depois de atualizar, peça para quem hospeda atualizar também.
Seus dados (`%APPDATA%\Limb`) são mantidos em qualquer atualização.

### Desenvolver

Precisa do [Node.js 24](https://nodejs.org) ou mais novo.

```sh
npm install
npm run desktop   # app desktop com servidor embutido
npm start         # só o servidor, em http://localhost:3000 (abra no Chrome)
npm test          # testes
npm run dist      # gera os .exe em dist/
```

## Jogar com os amigos

Uma pessoa hospeda e as outras entram no computador dela. O app guia tudo: na primeira vez abre sozinho a
janela **Servidor**; depois ela fica no link **servidor**, embaixo, ao lado do seu nome.

### Seus amigos entram só com um link (recomendado)

Quem hospeda faz a parte chata uma vez; o amigo só abre o link. Ele **não precisa do Tailscale**.

**Quem hospeda** clica em **🏠 Hospedar → Pela internet, só com um link**:

1. **Tailscale** ligado neste computador (só você precisa dele; a janela tem o botão certo: Baixar, Entrar, Ligar).
2. **Publicar na internet → Ativar.** Na primeira vez, o Tailscale abre uma página no navegador: clique em
   **Enable** (libera o Funnel/HTTPS na sua rede do Tailscale) e volte. O passo fica verde:
   **No ar:** `https://<computador>.<tailnet>.ts.net`.
3. **Voz para quem está no 4G** (opcional, recomendado): cole a chave TURN da Cloudflare
   (veja [Voz e tela entre redes diferentes](#voz-e-tela-entre-redes-diferentes)).
4. **Copiar convite** → cola no WhatsApp/Discord. O convite é só o link: ninguém vê nem digita código.
5. **Salvar e reiniciar.**

Depois, o botão **Convidar amigos** (no topo da janela principal) copia o convite de novo a qualquer hora.

**Quem entra** abre o link. A página oferece:

- **Entrar pelo navegador** (no celular, é o caminho principal): abre a tela de **Criar conta** já com o
  convite ("✓ Você foi convidado para …"): é só escolher o nome e a senha;
- **Baixar o Limb para Windows**: o convite é copiado antes do download, e o app recém-instalado o encontra
  sozinho ("Encontramos o convite que você copiou") — é só clicar em **Salvar e entrar** e criar a conta;
- **Já tenho o Limb: abrir no app**: o app pergunta se você quer entrar no servidor (com o nome dele) e entra.

O link é a tranca: dentro dele vai um código secreto de 12 caracteres, gerado pelo app, e só quem abriu o
link cria conta (quem hospeda também entra sem digitar nada). O link vazou ou você quer cortar os antigos?
**Servidor → Gerar link novo**: vale na hora, sem reiniciar; os links antigos passam a dizer "Este convite não
vale mais", e quem já tem conta continua entrando normalmente. Quem abre o site sem o link vê "Este servidor
só aceita convidados" e um campo para colar o link.

O servidor só escuta em `127.0.0.1`: o Funnel entrega as conexões localmente, e nenhum aviso do firewall
aparece. O Limb desliga o Funnel quando você sai do app, troca para o servidor de outra pessoa ou volta para
o modo Tailscale (com `tailscale funnel --https=443 off`, nunca `reset`: outras configurações do Tailscale
ficam). Se o Funnel cair com o Limb aberto, a janela avisa no topo, com o botão **Publicar agora**.

### Todo mundo no Tailscale (alternativa)

A conexão vai pela rede do [Tailscale](https://tailscale.com) (grátis), sem nada na internet aberta, mas
**cada amigo** precisa instalar o Tailscale.

1. **Quem hospeda** clica em **🏠 Hospedar → Pelo Tailscale**:
   - **Abrir página do Tailscale** → no seu computador, **⋯ → Share…** → manda o link para o amigo;
   - **Copiar convite** → cola no WhatsApp/Discord (o convite é um link `http://100.x:3000/convite/…`);
   - **Salvar e reiniciar**. Se o Windows perguntar sobre o firewall, **Permitir**.
2. **Quem entra** instala o Tailscale, abre o link de compartilhamento e aceita, clica em **🚪 Entrar** e
   cola o link do convite (ou a mensagem inteira). O app testa a conexão e, se algo faltar, diz o quê
   ("aceite o link de compartilhamento", "o computador dele está desligado"…). Depois é só **Salvar e
   reiniciar** e criar a conta (o convite já vai junto).

### Para todos

Quem hospeda pode fechar a janela: o Limb continua rodando no ícone perto do relógio, e os amigos seguem
conversando enquanto o computador estiver ligado. Em **Servidor → Opções**, marque **Iniciar com o Windows**
para o servidor subir sozinho ao ligar o PC (o Funnel volta sozinho junto), e dê um **Nome do servidor**
(aparece no convite; vazio = `Servidor do <computador>`). Para hospedar, prefira o **instalador**: na
versão portátil o Windows pode perguntar sobre o firewall a cada abertura.

Para trocar de servidor, clique no botão de servidor (embaixo, ao lado do seu nome) ou em **Conectar a outro
servidor…** no login: aparecem os servidores em que você já entrou, com a bolinha verde nos que estão no ar
(um clique troca), e um campo para colar o convite de um amigo novo. Hospedando com o Tailscale desligado, o
Limb avisa no topo da janela, porque ninguém de fora consegue entrar.

Sem microfone (ou com ele bloqueado no Windows), você entra na chamada só ouvindo; ao conectar um microfone,
o Limb liga sozinho (bloqueado no Windows: libere e clique no botão do microfone). No navegador, os sons
só tocam depois do primeiro clique na página (regra do navegador); no app desktop, desde o início.

### Como os amigos alcançam o seu computador

| Situação | O que fazer |
|---|---|
| Pela internet, só com um link (**recomendado**) | Hospedar → **Pela internet**. O Funnel do Tailscale publica o seu servidor em `https://<computador>.<tailnet>.ts.net`, com HTTPS. Só você instala o Tailscale; não precisa mexer no roteador. |
| Mesma casa / mesma rede | Use o endereço `192.168.x.x` que o app mostra. |
| Todos no Tailscale | Instalem o [Tailscale](https://tailscale.com) (grátis) e aceitem o compartilhamento. Use o endereço `100.x.x.x` que o app mostra. Nada fica aberto na internet. |
| Pela internet, sem Tailscale | Abra (redirecione) a porta no roteador para o seu computador e passe o seu IP público. **Atenção:** a conexão vai sem criptografia (`http://`); prefira o link do Funnel ou uma VPS com HTTPS. |
| Servidor sempre ligado | VPS, veja abaixo. |

### Voz e tela entre redes diferentes

A voz e a tela vão direto de uma pessoa para outra (WebRTC), mesmo no modo pela internet: o Funnel só leva
as páginas e as mensagens, não a mídia. Para atravessar o roteador, o app usa o STUN público do Google, o
que resolve a maioria dos casos. No 4G e atrás de CGNAT (algumas internets de casa, redes de
empresa/faculdade), a voz não conecta direto e precisa de um servidor TURN.

**TURN da Cloudflare (o mais fácil):** no [painel da Cloudflare](https://dash.cloudflare.com), **Realtime →
TURN → Criar chave**, e cole o ID da chave e o token da API no passo **Voz para quem está no 4G** da janela
Servidor. São **1.000 GB grátis por mês**, o que sobra para um grupo de amigos. O token fica só no
`settings.json` de quem hospeda e não aparece na tela de novo; o servidor pede credenciais de 24 h e renova
sozinho. Se a Cloudflare falhar, a voz segue só com STUN e o Limb tenta de novo.

**Outro TURN** (por exemplo o [coturn](https://github.com/coturn/coturn)): configure em `iceServers` (app)
ou `ICE_SERVERS` (servidor):

```json
[{ "urls": "stun:stun.l.google.com:19302" },
 { "urls": "turn:turn.seudominio.com:3478", "username": "usuario", "credential": "senha" }]
```

Com todos no Tailscale, a conexão direta quase sempre funciona sem TURN.

## Hospedar numa VPS

Precisa do [Node.js 24](https://nodejs.org) ou mais novo.

```sh
git clone https://github.com/AllanDeOliveira/Limb.git limb && cd limb
npm ci --omit=dev
INVITE_CODE=meus-amigos HOST=127.0.0.1 TRUST_PROXY=1 node server.js
```

Para atualizar o servidor: `npm run atualizar` (faz `git pull` e reinstala as dependências) e reinicie o processo.

Na frente, um proxy com HTTPS. Com o [Caddy](https://caddyserver.com), o `Caddyfile` inteiro é:

```
chat.seudominio.com {
	reverse_proxy localhost:3000
}
```

No app, cada amigo entra em `https://chat.seudominio.com`. Pelo navegador também funciona. Com
`INVITE_CODE`, mande o link `https://chat.seudominio.com/convite/<código>`: o código vai dentro do link, e
ninguém digita. Num banco novo, crie a sua conta (a do dono) também por esse link: sem convite, só um pedido
feito no próprio servidor, sem proxy no meio (`http://127.0.0.1:3000`, por um túnel SSH, por exemplo), cria
a primeira conta.

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `HOST` | todas as interfaces | `127.0.0.1` para aceitar só o proxy local |
| `DB_FILE` | `limb.db` | Arquivo do banco (SQLite) |
| `INVITE_CODE` | vazio | Se definido, só cria conta quem abrir o link de convite (menos a primeira conta, a do dono, se criada na própria máquina e sem proxy): o código vai dentro do link, `https://seu.dominio/convite/<código>` (e conta antiga sem senha só define a senha com ele). Código errado na página do convite conta no limite de tentativas por IP |
| `SERVER_NAME` | `Limb` | Nome que aparece na página de convite e em `/api/info` (até 60 caracteres) |
| `ICE_SERVERS` | STUN do Google | Lista JSON de servidores STUN/TURN (se não for uma lista, usa o padrão e avisa no log) |
| `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` | vazio | Chave do TURN da Cloudflare (Realtime → TURN): quem está no 4G ou atrás de CGNAT entra na voz. Credenciais de 24 h, renovadas sozinhas; o token nunca sai do servidor |
| `TRUST_PROXY` | vazio | `1` atrás de um proxy em **outra** máquina, para os limites de tentativas de login e de cadastros usarem o IP real (o último do `X-Forwarded-For`, o que o proxy acrescenta). Proxy na mesma máquina (Funnel do Tailscale, Caddy local) conecta por `127.0.0.1`/`::1`, e aí o `X-Forwarded-For` já vale sem `TRUST_PROXY` |

`GET /api/info` devolve `{ convite, primeiraConta, semDono, nome, versao }`: `convite` é true quando há `INVITE_CODE` e
criar conta pede o link; `primeiraConta` é true enquanto o servidor não tem nenhuma conta e o pedido vem da
própria máquina, sem proxy (aí a próxima conta, sem convite, é a do dono; pela internet o servidor vazio pede
convite como sempre); `semDono` é esse servidor vazio visto de fora (não libera nada: a tela só explica que a
conta do dono se cria no app de quem hospeda ou pelo link de convite); mais o nome e a versão. O convite pela internet é `https://<servidor>/convite/<código>`; o app desktop também abre
`limb://entrar?servidor=<origem>&convite=<código>`.

No app desktop, as mesmas opções ficam em `%APPDATA%\Limb\settings.json` (`porta`,
`compartilharNaRede`, `codigoConvite` (o código dentro do link; troque com **Gerar link novo**), `iceServers`,
`endpoint`), mais `internet` (publicar pelo Funnel),
`nomeServidor` (o nome no convite; vazio = `Servidor do <computador>`) e `turnCloudflare` (`{ keyId, token }`).

## Limites

- **Até 8 pessoas por canal de voz.** A mídia vai direto entre todos (malha): cada um envia uma cópia do
  áudio para cada outra pessoa. Para chamadas maiores seria preciso um servidor de mídia (SFU).
- **Compartilhar tela usa a sua internet de upload** para cada pessoa que assiste (só quem clicou em
  AO VIVO). Por pessoa: 1080p30 ≈ 4,5 Mbit/s, 1080p60 ≈ 7, 1440p60 ≈ 12 (o diálogo mostra a estimativa);
  com upload fraco, use 720p ou 15/30 fps.
- **Os limites de tentativas de login ficam na memória** e zeram quando o servidor reinicia.
- **Pela internet, o servidor só fica no ar enquanto o PC de quem hospeda está ligado** (com o Limb
  aberto). O limite de banda do Funnel não pesa na chamada: voz e tela vão direto entre as pessoas (ou pelo
  TURN); pelo Funnel passam só as páginas e as mensagens.
- **Com o Funnel, o seu servidor fica alcançável por qualquer pessoa na internet.** Só o link de convite
  deixa alguém criar conta (a não ser a sua, a primeira, criada no próprio computador): mande só para os amigos e não poste em lugar público. Vazou? **Servidor → Gerar
  link novo**.
- **Se o Windows desligar ou o app travar, o Funnel continua ligado** apontando para a porta do Limb; ele é
  corrigido na próxima vez que o Limb abrir.
- **"Incluir o som do computador"** captura tudo que toca, inclusive a voz da chamada: use fone de ouvido.
  Só existe no Windows (app) e no Chrome (aba ou tela).
- **Mensagens não são criptografadas de ponta a ponta.** Quem hospeda tem acesso ao banco.
- **Todos os usuários do servidor veem todos os canais.** Ainda não há cargos e permissões.
- Sem anexos, mensagens diretas, vídeo de câmera ou app para Mac/Linux por enquanto.

## Como funciona

| Parte | Arquivo |
|---|---|
| API REST e Gateway (WebSocket com opcodes no estilo do Discord, RESUME, JSON) | [server.js](server.js) |
| Gateway de voz, sinalização WebRTC e quem assiste cada tela (op 101) | [voice.js](voice.js) |
| Snowflakes e busca | [lib.js](lib.js) |
| Interface (stores no estilo Flux, sem framework) | [public/app.js](public/app.js) |
| Voz e compartilhamento de tela no cliente | [public/voz.js](public/voz.js) |
| Troca automática de microfone e saída | [public/dispositivos.js](public/dispositivos.js) |
| Sons da chamada (WebAudio) | [public/sons.js](public/sons.js) |
| Página do link de convite (`/convite/<código>`) | [public/convite.html](public/convite.html), [public/convite.js](public/convite.js) |
| App desktop (Electron), Tailscale, Funnel, links `limb://` e atualização automática | [desktop/](desktop/) |

Banco: SQLite embutido no Node (`node:sqlite`). Dependências: [`ws`](https://github.com/websockets/ws) (servidor) e
[`electron-updater`](https://www.electron.build/auto-update) (atualização do app).

## Publicar uma versão

```sh
npm version minor          # ou patch / major: sobe a versão no package.json e cria a tag
git push --follow-tags     # o GitHub Actions testa, gera os .exe e publica o release
```

Quem usa o instalador recebe a versão nova sozinho; quem usa o terminal roda o comando de instalação de novo.

## Licença

[MIT](LICENSE)
