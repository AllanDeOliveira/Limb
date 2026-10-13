// App desktop no mesmo desenho do Discord (ver EVIDENCIAS.md, seção 11): casca Electron que carrega a
// interface web de um endpoint (WEBAPP_ENDPOINT lá, `endpoint` aqui) e expõe uma ponte nativa mínima
// (DiscordNative lá, LimbNative aqui). Sem endpoint configurado, sobe o próprio servidor embutido.
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, net, session, shell, utilityProcess } from 'electron';
import * as tailscale from './tailscale.js';
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOME = 'Limb';
const raiz = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dados = app.getPath('userData');
const arqConfig = path.join(dados, 'settings.json');

// O app se chamava "REA Discord": na primeira abertura como Limb, traz configurações, banco e login salvo
// de %APPDATA%\REA Discord (sem os caches do Chromium). A pasta antiga fica intacta.
const pastaAntiga = path.join(app.getPath('appData'), 'REA Discord');
if (!existsSync(arqConfig) && existsSync(path.join(pastaAntiga, 'settings.json'))) {
  try {
    cpSync(pastaAntiga, dados, { recursive: true, force: false, filter: (f) => !/[\\/](\w*Cache|Code Cache|Crashpad)([\\/]|$)/.test(f) });
    for (const ext of ['', '-wal', '-shm']) {
      const velho = path.join(dados, `discord.db${ext}`);
      if (existsSync(velho) && !existsSync(path.join(dados, `limb.db${ext}`))) renameSync(velho, path.join(dados, `limb.db${ext}`));
    }
  } catch (e) { console.error('migração da pasta antiga falhou:', e); }
}
const arqJanela = path.join(dados, 'janela.json');

const PADRAO = {
  endpoint: null, // ex.: "http://100.101.102.103:3000" para entrar no servidor de um amigo
  compartilharNaRede: false, // true: outros computadores podem entrar no servidor deste
  porta: 3000,
  codigoConvite: '', // se preenchido, só cria conta quem tiver o código
  iceServers: null, // null = STUN público do Google; lista própria para incluir um TURN (ver README)
  conviteRecebido: '', // código de convite do servidor do amigo: já vem preenchido no login
};
const primeiraVez = !existsSync(arqConfig);
const lerJson = (f, padrao) => { try { return { ...padrao, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch { return { ...padrao }; } };
const config = lerJson(arqConfig, PADRAO);
if (!existsSync(arqConfig)) writeFileSync(arqConfig, JSON.stringify(PADRAO, null, 2)); // deixa o arquivo pronto para editar
// Variável de ambiente vence o arquivo, como DISCORD_WEBAPP_ENDPOINT vence settings.json no Discord
const endpointExterno = process.env.LIMB_ENDPOINT || config.endpoint;

// Um app por máquina: segunda instância só traz a janela da primeira para frente
const unico = app.requestSingleInstanceLock();
if (!unico) app.quit();

// Microfone e tela exigem origem segura. Servidor de outra máquina em http:// não é; o Discord faz igual:
// "Allowing insecure origin" para um WEBAPP_ENDPOINT http que não seja localhost.
if (endpointExterno?.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(endpointExterno + '/')) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', new URL(endpointExterno).origin);
}

let janela = null, servidor = null, janelaConexao = null, erroConexao = null;

function subirServidor() {
  return new Promise((resolve, reject) => {
    servidor = utilityProcess.fork(path.join(raiz, 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(config.porta),
        HOST: config.compartilharNaRede ? '' : '127.0.0.1',
        DB_FILE: path.join(dados, 'limb.db'), // dados ficam no perfil do usuário, não na pasta do app
        INVITE_CODE: config.codigoConvite || '',
        ...(config.iceServers ? { ICE_SERVERS: JSON.stringify(config.iceServers) } : {}),
      },
      stdio: 'inherit',
    });
    // 127.0.0.1, não localhost: localhost pode resolver para ::1 e cair em outro programa na mesma porta
    servidor.on('message', (m) => { if (m?.pronto) resolve(`http://127.0.0.1:${m.pronto}`); });
    servidor.on('exit', (code) => reject(new Error(`O servidor parou (código ${code}). A porta ${config.porta} pode estar em uso por outro programa.`)));
  });
}

function criarJanela(endpoint) {
  const origem = new URL(endpoint).origin;
  const salvo = lerJson(arqJanela, { width: 1280, height: 760 });
  janela = new BrowserWindow({
    ...salvo,
    minWidth: 940, minHeight: 500, // MIN_WIDTH/MIN_HEIGHT do Discord
    title: NOME,
    backgroundColor: '#313338', // sem flash branco antes da página carregar
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(raiz, 'desktop', 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      // Minimizado numa chamada, o Chromium estrangularia timers (heartbeat da voz, indicador de fala)
      // até a conexão cair. O Discord desliga isso também.
      backgroundThrottling: false,
    },
  });
  if (salvo.maximizado) janela.maximize();
  janela.once('ready-to-show', () => janela.show());

  const salvar = () => {
    if (janela.isMinimized()) return;
    writeFileSync(arqJanela, JSON.stringify({ ...janela.getNormalBounds(), maximizado: janela.isMaximized() }));
  };
  janela.on('close', salvar);
  janela.on('focus', () => janela.flashFrame(false));

  // Só a origem do servidor pode pedir microfone, tela e notificação
  const permitido = (wc, perm, url) => ['media', 'display-capture', 'notifications'].includes(perm) && new URL(url || wc.getURL()).origin === origem;
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, det) => cb(permitido(wc, perm, det.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((wc, perm, origemReq) => permitido(wc, perm, origemReq));

  // Links externos no navegador padrão; a janela nunca sai do servidor
  const externo = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  janela.webContents.setWindowOpenHandler(({ url }) => { externo(url); return { action: 'deny' }; });
  janela.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origem) { e.preventDefault(); externo(url); }
  });
  // Servidor do amigo fora do ar / endereço errado: abre a janela de servidor com o erro
  janela.webContents.on('did-fail-load', (_e, _codigo, descricao, url, principal) => {
    if (principal) abrirConexao(`Não consegui abrir ${url} (${descricao}). Confira o endereço ou se o servidor está ligado.`);
  });

  // Ponte nativa: valida o remetente (só a página do servidor fala com o processo principal)
  const daPagina = (e) => { try { return new URL(e.senderFrame.url).origin === origem; } catch { return false; } };
  ipcMain.on('limb:atencao', (e, mencoes) => {
    if (!daPagina(e)) return;
    app.setBadgeCount(Math.max(0, Math.trunc(Number(mencoes)) || 0)); // macOS/Linux; no Windows não faz nada
    if (mencoes > 0 && !janela.isFocused()) janela.flashFrame(true); // pisca na barra de tarefas
  });
  ipcMain.on('limb:focar', (e) => {
    if (!daPagina(e)) return;
    if (janela.isMinimized()) janela.restore();
    janela.show(); janela.focus();
  });
  ipcMain.on('limb:conexao', (e) => { if (daPagina(e)) abrirConexao(); });

  // Compartilhar tela. O Electron não tem o seletor do Chrome: a página lista as fontes (com miniatura),
  // a pessoa escolhe, e o getDisplayMedia seguinte recebe essa fonte. A escolha vale por 15 s e uma vez.
  let fontes = new Map(), escolha = null;
  ipcMain.handle('limb:fontes', async (e) => {
    if (!daPagina(e)) return [];
    const lista = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    fontes = new Map(lista.map((f) => [f.id, f]));
    return lista.map((f) => ({ id: f.id, nome: f.name, tela: f.id.startsWith('screen:'), miniatura: f.thumbnail.toDataURL() }));
  });
  ipcMain.handle('limb:escolherFonte', (e, id, comAudio) => {
    if (!daPagina(e) || !fontes.has(id)) return false;
    escolha = { fonte: fontes.get(id), comAudio, ate: Date.now() + 15_000 };
    return true;
  });
  session.defaultSession.setDisplayMediaRequestHandler((req, callback) => {
    const c = escolha;
    escolha = null;
    let ok = false;
    try { ok = !!c && c.ate > Date.now() && new URL(req.securityOrigin).origin === origem; } catch {}
    if (!ok) return callback({}); // sem escolha válida: nega
    // som do sistema só existe no Windows ('loopback' = tudo que toca no computador)
    callback({ video: c.fonte, ...(c.comAudio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
  });

  // código de convite recebido vai no #, sem passar pelo servidor; a página preenche o campo e apaga
  janela.loadURL(config.endpoint && config.conviteRecebido ? `${endpoint}/#convite=${encodeURIComponent(config.conviteRecebido)}` : endpoint);
  if (primeiraVez) janela.once('ready-to-show', () => abrirConexao());
}

// ── Janela "Servidor": hospedar aqui ou entrar no servidor de um amigo ────────────────────────
function abrirConexao(erro = null) {
  erroConexao = erro;
  if (janelaConexao) { janelaConexao.focus(); janelaConexao.reload(); return; }
  janelaConexao = new BrowserWindow({
    width: 600, height: 760, minWidth: 480, minHeight: 500, minimizable: false, title: `${NOME} — Servidor`,
    parent: janela ?? undefined, modal: !!janela, autoHideMenuBar: true, backgroundColor: '#313338',
    webPreferences: { preload: path.join(raiz, 'desktop', 'conexao-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  janelaConexao.on('closed', () => {
    janelaConexao = null;
    if (!janela) app.quit(); // aberta sozinha (o app não conseguiu iniciar) e fechada sem salvar
  });
  janelaConexao.loadFile(path.join(raiz, 'desktop', 'conexao.html'));
}
const daConexao = (e) => janelaConexao && e.sender === janelaConexao.webContents;
ipcMain.handle('conexao:ler', (e) => {
  if (!daConexao(e)) return null;
  const ips = Object.entries(networkInterfaces()).flatMap(([nome, lista]) => (lista ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ nome, endereco: i.address })));
  return { config, ips, erro: erroConexao, primeiraVez, portatil: !!process.env.PORTABLE_EXECUTABLE_DIR };
});
ipcMain.handle('conexao:tailscale', (e) => (daConexao(e) ? tailscale.status() : null));
ipcMain.handle('conexao:tailscaleLigar', async (e) => {
  if (!daConexao(e)) return null;
  const st = await tailscale.status();
  if (!st.instalado) { shell.openExternal(tailscale.DOWNLOAD); return { baixando: true }; }
  return tailscale.ligar(st.estado, (url) => shell.openExternal(url));
});
ipcMain.handle('conexao:abrirCompartilhar', (e) => { if (daConexao(e)) shell.openExternal(tailscale.PAINEL_MAQUINAS); });
ipcMain.handle('conexao:copiar', (e, texto) => { if (daConexao(e)) clipboard.writeText(String(texto).slice(0, 2000)); });
ipcMain.handle('conexao:testar', async (e, url) => {
  if (!daConexao(e)) return { ok: false, erro: 'negado' };
  let origem;
  try { origem = new URL(url).origin; if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { return { ok: false, erro: 'endereço inválido (use http://IP:porta)' }; }
  try {
    const r = await net.fetch(`${origem}/api/info`, { signal: AbortSignal.timeout(5000) });
    return r.ok && 'convite' in (await r.json()) ? { ok: true } : { ok: false, erro: 'Respondeu, mas não é um servidor Limb.' };
  } catch {
    // Explica o motivo mais provável, olhando o Tailscale
    const host = new URL(origem).hostname;
    if (!/^100\./.test(host)) return { ok: false, erro: 'Sem resposta. Confira o endereço e se o app do seu amigo está aberto.' };
    const st = await tailscale.status();
    if (!st.instalado) return { ok: false, erro: 'Esse endereço é do Tailscale: instale e entre no Tailscale (acima).' };
    if (st.estado !== 'Running') return { ok: false, erro: 'Seu Tailscale está desligado: ligue no passo 1, acima.' };
    if (host === st.ip) return { ok: false, erro: 'Esse é o endereço deste computador. Para receber amigos aqui, escolha “Hospedar”.' };
    const par = st.pares.find((p) => p.ip === host);
    if (!par) return { ok: false, erro: 'Você ainda não tem acesso ao computador do seu amigo: abra o link de compartilhamento que ele mandou e clique em aceitar.' };
    if (!par.online) return { ok: false, erro: `O computador do seu amigo (${par.nome}) está desligado ou sem Tailscale.` };
    return { ok: false, erro: `O computador dele (${par.nome}) está online, mas o servidor não respondeu: o app dele está aberto, hospedando, com "Deixar outros computadores entrarem" marcado? O firewall dele pode ter bloqueado o app.` };
  }
});
ipcMain.handle('conexao:salvar', (e, novo) => {
  if (!daConexao(e)) return { erro: 'negado' };
  const porta = Math.trunc(Number(novo.porta));
  if (!(porta >= 1024 && porta <= 65535)) return { erro: 'Porta precisa estar entre 1024 e 65535.' };
  let endpoint = null;
  if (novo.modo === 'entrar') {
    try { const u = new URL(String(novo.endpoint)); if (!/^https?:$/.test(u.protocol)) throw 0; endpoint = u.origin; }
    catch { return { erro: 'Endereço inválido. Exemplo: http://100.101.102.103:3000' }; }
  }
  Object.assign(config, {
    endpoint, porta, compartilharNaRede: !!novo.compartilharNaRede, codigoConvite: String(novo.codigoConvite ?? '').slice(0, 100),
    conviteRecebido: endpoint ? String(novo.conviteRecebido ?? '').slice(0, 100) : '',
  });
  writeFileSync(arqConfig, JSON.stringify(config, null, 2));
  app.relaunch();
  app.exit(0);
  return {};
});

app.on('second-instance', () => { if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('quit', () => servidor?.kill());

app.whenReady().then(async () => {
  if (!unico) return;
  try {
    criarJanela(endpointExterno || await subirServidor());
  } catch (e) {
    // não fecha o app: deixa trocar a porta ou entrar no servidor de outra pessoa
    abrirConexao(`Não foi possível iniciar o servidor: ${e.message}`);
  }
});
process.on('uncaughtException', (e) => { dialog.showErrorBox(NOME, e.stack ?? String(e)); });
