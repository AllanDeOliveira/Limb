// App desktop no mesmo desenho do Discord: casca Electron que carrega a
// interface web de um endpoint (WEBAPP_ENDPOINT lá, `endpoint` aqui) e expõe uma ponte nativa mínima
// (DiscordNative lá, LimbNative aqui). Sem endpoint configurado, sobe o próprio servidor embutido.
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, Notification, session, shell, Tray, utilityProcess } from 'electron';
import * as tailscale from './tailscale.js';
import { iniciarAtualizacao } from './atualizacao.js';
import { appendFileSync, cpSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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

// Registro em %APPDATA%\Limb\limb.log: no computador de um amigo é o único jeito de saber o que deu errado.
// Passou de 512 KB, recomeça (não cresce para sempre).
const arqLog = path.join(dados, 'limb.log');
function registrar(...partes) {
  try {
    if (existsSync(arqLog) && statSync(arqLog).size > 512 * 1024) writeFileSync(arqLog, '');
    appendFileSync(arqLog, `${new Date().toISOString()} v${app.getVersion()} ${partes.map((p) => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
  } catch {}
}
// Janela que trava ou cujo processo morre fica em branco sem avisar: registra para o diagnóstico
function vigiar(win, nome) {
  win.webContents.on('render-process-gone', (_e, d) => registrar(`[${nome}] processo da página morreu:`, d));
  win.webContents.on('did-fail-load', (_e, codigo, desc, url, principal) => { if (principal) registrar(`[${nome}] falhou ao carregar ${url}: ${desc} (${codigo})`); });
  win.on('unresponsive', () => registrar(`[${nome}] parou de responder`));
  win.webContents.on('console-message', (e) => { if (e.level === 'error') registrar(`[${nome}] erro na página: ${e.message} (${e.sourceId}:${e.lineNumber})`); });
}

const PADRAO = {
  endpoint: null, // ex.: "http://100.101.102.103:3000" para entrar no servidor de um amigo
  compartilharNaRede: false, // true: outros computadores podem entrar no servidor deste
  porta: 3000,
  codigoConvite: '', // se preenchido, só cria conta quem tiver o código
  iceServers: null, // null = STUN público do Google; lista própria para incluir um TURN (ver README)
  conviteRecebido: '', // código de convite do servidor do amigo: já vem preenchido no login
  iniciarComWindows: false, // hospedando: sobe escondido na bandeja ao ligar o computador
  historico: [], // servidores em que já entrou: [{ url, nome, codigo, ultimoUso }], mais recente primeiro
  avisouBandeja: false, // o aviso "continua rodando perto do relógio" aparece uma vez só
};
const primeiraVez = !existsSync(arqConfig);
const lerJson = (f, padrao) => { try { return { ...padrao, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch { return { ...padrao }; } };
const config = lerJson(arqConfig, PADRAO);
if (!existsSync(arqConfig)) writeFileSync(arqConfig, JSON.stringify(PADRAO, null, 2)); // deixa o arquivo pronto para editar
// Variável de ambiente vence o arquivo, como DISCORD_WEBAPP_ENDPOINT vence settings.json no Discord
const endpointExterno = process.env.LIMB_ENDPOINT || config.endpoint;
// Hospedando para amigos, fechar a janela não pode derrubar o servidor deles: o app vai para a bandeja.
// Só entrando no servidor de alguém (ou hospedando só para si), fechar continua fechando.
const hospedandoAmigos = !endpointExterno && config.compartilharNaRede;
const iniciouOculto = process.argv.includes('--oculto'); // aberto pelo "Iniciar com o Windows"
const salvarConfig = () => writeFileSync(arqConfig, JSON.stringify(config, null, 2));
// Reinicia sem o --oculto: quem pediu a troca está olhando para a tela
const reiniciar = () => { app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--oculto') }); app.exit(0); };

// Histórico: o mesmo endereço sobe para o topo; guarda os 8 mais recentes
function lembrarServidor({ url, codigo = '', nome }) {
  const antigo = config.historico.find((h) => h.url === url);
  config.historico = [
    { url, codigo: codigo || antigo?.codigo || '', nome: nome || antigo?.nome || new URL(url).host, ultimoUso: Date.now() },
    ...config.historico.filter((h) => h.url !== url),
  ].slice(0, 8);
}
// Quem já estava num servidor antes do histórico existir: ele entra na lista
if (config.endpoint && !config.historico.some((h) => h.url === config.endpoint)) {
  lembrarServidor({ url: config.endpoint, codigo: config.conviteRecebido });
  salvarConfig();
}

// Um app por máquina: segunda instância só traz a janela da primeira para frente
const unico = app.requestSingleInstanceLock();
if (!unico) app.quit();

// Microfone e tela exigem origem segura. Servidor de outra máquina em http:// não é; o Discord faz igual:
// "Allowing insecure origin" para um WEBAPP_ENDPOINT http que não seja localhost.
if (endpointExterno?.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(endpointExterno + '/')) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', new URL(endpointExterno).origin);
}

let janela = null, servidor = null, janelaConexao = null, erroConexao = null, bandeja = null, saindo = false;

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
    backgroundColor: '#1e2023', // sem flash branco antes da página carregar
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
  vigiar(janela, 'principal');
  if (salvo.maximizado) janela.maximize();
  // Ligou junto com o Windows: o servidor sobe, a janela fica na bandeja até alguém clicar
  janela.once('ready-to-show', () => { if (!(iniciouOculto && hospedandoAmigos)) janela.show(); });

  const salvar = () => {
    if (janela.isMinimized()) return;
    writeFileSync(arqJanela, JSON.stringify({ ...janela.getNormalBounds(), maximizado: janela.isMaximized() }));
  };
  janela.on('close', (e) => {
    salvar();
    if (!hospedandoAmigos || saindo) return;
    e.preventDefault(); // esconder, não fechar: os amigos continuam conversando
    janela.hide();
    if (!config.avisouBandeja && Notification.isSupported()) {
      new Notification({ title: 'O Limb continua rodando', body: 'Seus amigos ainda conseguem conversar. Para encerrar de vez, use o ícone do Limb perto do relógio.' }).show();
      config.avisouBandeja = true;
      salvarConfig();
    }
  });
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
  // Trocar de servidor pela própria janela principal. A página só escolhe entre servidores do histórico;
  // endereço novo (convite) passa por uma confirmação nativa: um servidor não consegue mandar você para
  // outro lugar sem você ver.
  ipcMain.handle('limb:servidores', async (e) => {
    if (!daPagina(e)) return null;
    const lista = await Promise.all(config.historico.map(async (h) => ({ ...h, online: (await testarServidor(h.url)).ok })));
    return { atual: config.endpoint ?? null, lista };
  });
  // Hospedando com o Tailscale desligado, ninguém de fora consegue entrar, e quem hospeda não percebe:
  // a página consulta isto e mostra uma faixa com o botão de ligar
  ipcMain.handle('limb:hospedagem', async (e) => {
    if (!daPagina(e) || !hospedandoAmigos) return null;
    const st = await tailscale.status();
    return { instalado: !!st.instalado, ligado: st.estado === 'Running' };
  });
  ipcMain.handle('limb:ligarTailscale', async (e) => {
    if (!daPagina(e)) return null;
    const st = await tailscale.status();
    if (!st.instalado) { shell.openExternal(tailscale.DOWNLOAD); return { baixando: true }; }
    return tailscale.ligar(st.estado, (url) => shell.openExternal(url));
  });
  ipcMain.handle('limb:trocarServidor', (e, url) => (daPagina(e) ? trocarPara(url == null ? null : String(url)) : { erro: 'negado' }));
  ipcMain.handle('limb:entrarPorConvite', async (e, texto) => {
    if (!daPagina(e)) return { erro: 'negado' };
    const lido = lerConvite(texto);
    if (!lido) return { erro: 'Não achei um endereço no convite. Ele parece com http://100.101.102.103:3000' };
    const teste = await testarServidor(lido.url);
    if (!teste.ok) return { erro: teste.erro };
    const { response } = await dialog.showMessageBox(janela, {
      type: 'question', buttons: ['Entrar', 'Cancelar'], defaultId: 0, cancelId: 1, title: NOME,
      message: `Entrar no servidor ${lido.url}?`, detail: 'O Limb reinicia já conectado a ele. Você volta para cá pela lista de servidores.',
    });
    if (response !== 0) return { cancelado: true };
    const host = new URL(lido.url).hostname;
    const nome = await tailscale.status().then((st) => st.pares?.find((p) => p.ip === host)?.nome).catch(() => null);
    lembrarServidor({ url: lido.url, codigo: lido.codigo, nome });
    Object.assign(config, { endpoint: lido.url, conviteRecebido: lido.codigo });
    salvarConfig();
    reiniciar();
    return {};
  });

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

function mostrarJanela() {
  if (!janela || janela.isDestroyed()) return;
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

// ── Bandeja (perto do relógio): só existe hospedando para amigos ────────────────────────────
// Ícone desenhado aqui (o mesmo galho do logotipo): o projeto não tem arquivo de imagem para empacotar.
function iconeBandeja() {
  const t = 32, s = t / 24, px = Buffer.alloc(t * t * 4);
  const tracos = [[8, 4, 8, 20], [8, 14.5, 16.5, 7.5], [16.5, 7.5, 14.5, 4], [16.5, 7.5, 20, 8]].map((l) => l.map((v) => v * s));
  const distSeg = (x, y, [ax, ay, bx, by]) => {
    const dx = bx - ax, dy = by - ay, k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - k * dx, y - ay - k * dy);
  };
  const raio = 8;
  for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    const qx = Math.min(Math.max(cx, raio), t - raio), qy = Math.min(Math.max(cy, raio), t - raio);
    if ((cx - qx) ** 2 + (cy - qy) ** 2 > raio * raio) continue; // fora do quadrado arredondado: transparente
    const escuro = tracos.some((l) => distSeg(cx, cy, l) < 1.5 * s);
    px.set(escuro ? [0x05, 0x1b, 0x1d, 255] : [0x58, 0xe5, 0xf2, 255], (y * t + x) * 4); // BGRA
  }
  return nativeImage.createFromBitmap(px, { width: t, height: t, scaleFactor: 2 });
}

// "Iniciar com o Windows" só faz sentido no app instalado/portátil (no `npm run desktop`, abriria o Electron puro)
const podeIniciarComWindows = app.isPackaged && process.platform === 'win32';
function aplicarInicioComWindows() {
  if (!podeIniciarComWindows) return;
  app.setLoginItemSettings({
    openAtLogin: !!config.iniciarComWindows,
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, // portátil: o .exe original, não a cópia temporária
    args: ['--oculto'],
  });
}

function criarBandeja() {
  bandeja = new Tray(iconeBandeja());
  bandeja.setToolTip(`${NOME} — hospedando para seus amigos`);
  const menu = () => Menu.buildFromTemplate([
    { label: `Abrir o ${NOME}`, click: mostrarJanela },
    { label: 'Servidor…', click: () => abrirConexao() },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: !!config.iniciarComWindows, enabled: podeIniciarComWindows,
      click: (item) => { config.iniciarComWindows = item.checked; salvarConfig(); aplicarInicioComWindows(); } },
    { type: 'separator' },
    { label: 'Sair (seus amigos ficam sem servidor)', click: () => { saindo = true; app.quit(); } },
  ]);
  bandeja.setContextMenu(menu());
  bandeja.on('click', mostrarJanela);
  bandeja.on('right-click', () => bandeja.setContextMenu(menu())); // checkbox sempre com o valor salvo
}

// ── Janela "Servidor": hospedar aqui ou entrar no servidor de um amigo ────────────────────────
function abrirConexao(erro = null) {
  erroConexao = erro;
  if (janelaConexao) { janelaConexao.focus(); janelaConexao.reload(); return; }
  // Só aparece com a página pronta: antes, num computador, ela ficava em branco (nunca carregou) e a pessoa
  // não tinha o que fazer. Se não ficar pronta em 4 s, recarrega uma vez; em 8 s, mostra de qualquer jeito.
  const win = janelaConexao = new BrowserWindow({
    width: 600, height: 760, minWidth: 480, minHeight: 500, minimizable: false, title: `${NOME} — Servidor`, show: false,
    // Janela comum, sem `parent`/`modal`: num computador a versão modal nunca carregava (ficava em branco)
    autoHideMenuBar: true, backgroundColor: '#1e2023',
    webPreferences: { preload: path.join(raiz, 'desktop', 'conexao-preload.cjs'), contextIsolation: true, sandbox: true },
  });
  vigiar(win, 'servidor');
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) { registrar('[servidor] não ficou pronta em 4 s; recarregando'); win.reload(); } }, 4000);
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) { registrar('[servidor] ainda não pronta em 8 s; mostrando assim mesmo'); win.show(); } }, 8000);
  win.on('closed', () => {
    if (janelaConexao === win) janelaConexao = null;
    if (!janela) app.quit(); // aberta sozinha (o app não conseguiu iniciar) e fechada sem salvar
  });
  win.loadFile(path.join(raiz, 'desktop', 'conexao.html'));
}
const daConexao = (e) => janelaConexao && e.sender === janelaConexao.webContents;
ipcMain.handle('conexao:ler', (e) => {
  if (!daConexao(e)) return null;
  const ips = Object.entries(networkInterfaces()).flatMap(([nome, lista]) => (lista ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ nome, endereco: i.address })));
  return { config, ips, erro: erroConexao, primeiraVez, portatil: !!process.env.PORTABLE_EXECUTABLE_DIR, podeIniciarComWindows };
});
// Histórico: trocar com um clique (url null = este computador), esquecer, e o "Iniciar com o Windows"
function trocarPara(url) {
  if (url == null) { config.endpoint = null; config.conviteRecebido = ''; }
  else {
    const h = config.historico.find((x) => x.url === url);
    if (!h) return { erro: 'Esse servidor não está no histórico.' };
    lembrarServidor(h);
    Object.assign(config, { endpoint: h.url, conviteRecebido: h.codigo });
  }
  salvarConfig();
  reiniciar();
  return {};
}
ipcMain.handle('conexao:trocar', (e, url) => (daConexao(e) ? trocarPara(url) : { erro: 'negado' }));
ipcMain.handle('conexao:esquecer', (e, url) => {
  if (!daConexao(e)) return null;
  config.historico = config.historico.filter((h) => h.url !== url);
  salvarConfig();
  return config.historico;
});
ipcMain.handle('conexao:iniciarComWindows', (e, ligado) => {
  if (!daConexao(e)) return null;
  config.iniciarComWindows = !!ligado;
  salvarConfig();
  aplicarInicioComWindows();
  return config.iniciarComWindows;
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
ipcMain.handle('conexao:testar', (e, url) => (daConexao(e) ? testarServidor(url) : { ok: false, erro: 'negado' }));
// Convite colado: a mensagem inteira, só a URL, ou só "100.x.x.x:3000" (mesma regra da janela Servidor)
function lerConvite(texto) {
  const t = String(texto ?? '').slice(0, 2000);
  let url = /https?:\/\/[^\s<>"'()]+/.exec(t)?.[0];
  if (!url) { const m = /\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?\b/.exec(t); if (m) url = `http://${m[1]}:${m[2] ?? 3000}`; }
  try { url = url && new URL(url).origin; } catch { url = null; }
  return url ? { url, codigo: /c[óo]digo[^:\n]*:\s*(\S+)/i.exec(t)?.[1] ?? '' } : null;
}
async function testarServidor(url) {
  let origem;
  try { origem = new URL(url).origin; if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { return { ok: false, erro: 'endereço inválido (use http://IP:porta)' }; }
  try {
    const r = await net.fetch(`${origem}/api/info`, { signal: AbortSignal.timeout(5000) });
    return r.ok && 'convite' in (await r.json()) ? { ok: true } : { ok: false, erro: 'Respondeu, mas não é um servidor Limb.' };
  } catch {
    // Explica o motivo mais provável, olhando o Tailscale
    const host = new URL(origem).hostname;
    if (!/^100\./.test(host)) return { ok: false, erro: 'Sem resposta. Confira o endereço e se o computador do seu amigo está ligado com o Limb rodando.' };
    const st = await tailscale.status();
    if (!st.instalado) return { ok: false, erro: 'Esse endereço é do Tailscale: instale e entre no Tailscale (acima).' };
    if (st.estado !== 'Running') return { ok: false, erro: 'Seu Tailscale está desligado: ligue no passo 1, acima.' };
    if (host === st.ip) return { ok: false, erro: 'Esse é o endereço deste computador. Para receber amigos aqui, escolha “Hospedar”.' };
    const par = st.pares.find((p) => p.ip === host);
    if (!par) return { ok: false, erro: 'Você ainda não tem acesso ao computador do seu amigo: abra o link de compartilhamento que ele mandou e clique em aceitar.' };
    if (!par.online) return { ok: false, erro: `O computador do seu amigo (${par.nome}) está desligado ou sem Tailscale.` };
    return { ok: false, erro: `O computador dele (${par.nome}) está online, mas o servidor não respondeu: o Limb dele está rodando (pode estar só no ícone perto do relógio), hospedando, com "Deixar outros computadores entrarem" marcado? O firewall dele pode ter bloqueado o app.` };
  }
}
ipcMain.handle('conexao:salvar', async (e, novo) => {
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
  if (endpoint) {
    // nome do amigo no Tailscale ("pc-do-bruno"), que diz mais do que um 100.x.x.x
    const host = new URL(endpoint).hostname;
    const nome = await tailscale.status().then((st) => st.pares?.find((p) => p.ip === host)?.nome).catch(() => null);
    lembrarServidor({ url: endpoint, codigo: config.conviteRecebido, nome });
  }
  salvarConfig();
  reiniciar();
  return {};
});

app.on('second-instance', mostrarJanela); // abrir o atalho de novo traz a janela, mesmo escondida na bandeja
app.on('window-all-closed', () => { if (!bandeja) app.quit(); });
app.on('before-quit', () => { saindo = true; });
app.on('quit', () => servidor?.kill());

app.whenReady().then(async () => {
  if (!unico) return;
  try {
    criarJanela(endpointExterno || await subirServidor());
    if (hospedandoAmigos) { criarBandeja(); aplicarInicioComWindows(); }
  } catch (e) {
    // não fecha o app: deixa trocar a porta ou entrar no servidor de outra pessoa
    abrirConexao(`Não foi possível iniciar o servidor: ${e.message}`);
  }
  iniciarAtualizacao(() => janela ?? janelaConexao);
});
// showErrorBox bloqueia o processo inteiro até alguém fechar a caixa; se ela ficar atrás das janelas, o app
// parece congelado (janelas em branco). Depois de pronto, usa a caixa que não bloqueia.
process.on('uncaughtException', (e) => {
  registrar('erro não tratado:', e);
  if (app.isReady()) dialog.showMessageBox({ type: 'error', title: NOME, message: 'Algo deu errado no Limb.', detail: `${e.stack ?? e}\n\nDetalhes em ${arqLog}` }).catch(() => {});
  else dialog.showErrorBox(NOME, e.stack ?? String(e));
});
process.on('unhandledRejection', (e) => registrar('promessa rejeitada sem tratamento:', e));
registrar(`iniciando (${process.platform} ${process.arch}, Electron ${process.versions.electron})`);
