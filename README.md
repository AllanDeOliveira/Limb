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
- **Voz** com indicador de quem está falando, mudo, surdo e "silenciar só para mim"
- **Compartilhar tela** (720p30, 1080p30 ou 1080p60), com o som do computador no Windows
- **App para Windows** com notificações de menção e o servidor embutido; também funciona no navegador
- **Contas com senha** e código de convite opcional

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
(veja [Jogar com os amigos](#jogar-com-os-amigos)). A conta é criada no primeiro login, com nome e senha.

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

Uma pessoa hospeda e as outras entram no computador dela. A conexão é feita pelo
[Tailscale](https://tailscale.com) (grátis), e o app guia tudo: na primeira vez abre sozinho a janela
**Servidor**; depois ela fica no link **servidor**, embaixo, ao lado do seu nome.

1. **Tailscale.** A janela mostra se ele está instalado, ligado e logado, com o botão certo para cada caso
   (Baixar, Entrar, Ligar). Todos precisam dele.
2. **Quem hospeda** clica em **🏠 Hospedar**:
   - **Abrir página do Tailscale** → no seu computador, **⋯ → Share…** → manda o link para o amigo;
   - **Copiar convite** → cola no WhatsApp/Discord (o convite já tem o endereço e um código);
   - **Salvar e reiniciar**. Se o Windows perguntar sobre o firewall, **Permitir**.
3. **Quem entra** abre o link do Tailscale e aceita, clica em **🚪 Entrar** e cola a mensagem do convite
   inteira. O app acha o endereço e o código, testa a conexão e, se algo faltar, diz o quê
   ("aceite o link de compartilhamento", "o computador dele está desligado"…). Depois é só
   **Salvar e reiniciar** e criar a conta (o código de convite já vem preenchido).

O servidor só funciona enquanto o app de quem hospeda estiver aberto. Para hospedar, prefira o
**instalador**: na versão portátil o Windows pode perguntar sobre o firewall a cada abertura.

### Como os amigos alcançam o seu computador

| Situação | O que fazer |
|---|---|
| Mesma casa / mesma rede | Use o endereço `192.168.x.x` que o app mostra. |
| Pela internet (**recomendado**) | Instalem o [Tailscale](https://tailscale.com) (grátis) na mesma conta/rede. Use o endereço `100.x.x.x` que o app mostra. Tudo vai criptografado e não precisa mexer no roteador. |
| Pela internet, sem Tailscale | Abra (redirecione) a porta no roteador para o seu computador e passe o seu IP público. **Atenção:** a conexão vai sem criptografia (`http://`); prefira o Tailscale ou uma VPS com HTTPS. |
| Servidor sempre ligado | VPS, veja abaixo. |

### Voz e tela entre redes diferentes

A voz e a tela vão direto de uma pessoa para outra (WebRTC). Para atravessar o roteador, o app usa o STUN
público do Google, o que resolve a maioria dos casos. Se alguém está numa rede muito restrita (alguns 4G e
redes de empresa/faculdade), a voz não conecta. Nesse caso é preciso um servidor TURN (por exemplo o
[coturn](https://github.com/coturn/coturn)), configurado em `iceServers` (app) ou `ICE_SERVERS` (servidor):

```json
[{ "urls": "stun:stun.l.google.com:19302" },
 { "urls": "turn:turn.seudominio.com:3478", "username": "usuario", "credential": "senha" }]
```

Com o Tailscale, a conexão direta quase sempre funciona sem TURN.

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

No app, cada amigo entra em `https://chat.seudominio.com`. Pelo navegador também funciona.

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `HOST` | todas as interfaces | `127.0.0.1` para aceitar só o proxy local |
| `DB_FILE` | `limb.db` | Arquivo do banco (SQLite) |
| `INVITE_CODE` | vazio | Se definido, só cria conta quem tiver o código |
| `ICE_SERVERS` | STUN do Google | Lista JSON de servidores STUN/TURN |
| `TRUST_PROXY` | vazio | `1` atrás de proxy, para o limite de tentativas de login usar o IP real |

No app desktop, as mesmas opções ficam em `%APPDATA%\Limb\settings.json` (`porta`,
`compartilharNaRede`, `codigoConvite`, `iceServers`, `endpoint`).

## Limites

- **Até 8 pessoas por canal de voz.** A mídia vai direto entre todos (malha): cada um envia uma cópia do
  áudio para cada outra pessoa. Para chamadas maiores seria preciso um servidor de mídia (SFU).
- **Compartilhar tela usa a sua internet de upload** para cada pessoa que assiste. Em 1080p60, conte uns
  7 Mbit/s por pessoa; com upload fraco, use 720p.
- **"Incluir o som do computador"** captura tudo que toca, inclusive a voz da chamada: use fone de ouvido.
  Só existe no Windows (app) e no Chrome (aba ou tela).
- **Mensagens não são criptografadas de ponta a ponta.** Quem hospeda tem acesso ao banco.
- **Todos os usuários do servidor veem todos os canais.** Ainda não há cargos e permissões.
- Sem anexos, mensagens diretas, vídeo de câmera ou app para Mac/Linux por enquanto.

## Como funciona

| Parte | Arquivo |
|---|---|
| API REST e Gateway (WebSocket com opcodes no estilo do Discord, RESUME, ETF ou JSON) | [server.js](server.js) |
| Gateway de voz e sinalização WebRTC | [voice.js](voice.js) |
| Snowflakes e busca | [lib.js](lib.js) |
| Interface (stores no estilo Flux, sem framework) | [public/app.js](public/app.js) |
| Voz e compartilhamento de tela no cliente | [public/voz.js](public/voz.js) |
| Codificador ETF (compatível com o [erlpack](https://github.com/discord/erlpack)) | [public/etf.js](public/etf.js) |
| App desktop (Electron), Tailscale e atualização automática | [desktop/](desktop/) |

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
