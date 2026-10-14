// App desktop no mesmo desenho do Discord: casca Electron que carrega a
// interface web de um endpoint (WEBAPP_ENDPOINT lá, `endpoint` aqui) e expõe uma ponte nativa mínima
// (DiscordNative lá, LimbNative aqui). Sem endpoint configurado, sobe o próprio servidor embutido.
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, Notification, session, shell, Tray, utilityProcess } from 'electron';
import * as tailscale from './tailscale.js';
import { iniciarAtualizacao } from './atualizacao.js';
import { ehTailscale, gerarCodigo, lerConvite, lerConviteCopiado, lerDeepLink, linkConvite, mensagemConvite } from './convite.js';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOME = 'Limb';
const raiz = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dados = app.getPath('userData');
const arqConfig = path.join(dados, 'settings.json');

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
  codigoConvite: '', // vai escondido no link de convite; só cria conta quem abriu o link (troca: "Gerar link novo")
  iceServers: null, // null = STUN público do Google; lista própria para incluir um TURN (ver README)
  conviteRecebido: '', // o código que veio no link do amigo: vai escondido para a tela de criar conta
  iniciarComWindows: false, // hospedando: sobe escondido na bandeja ao ligar o computador
  historico: [], // servidores em que já entrou: [{ url, nome, codigo, ultimoUso }], mais recente primeiro
  avisouBandeja: false, // o aviso "continua rodando perto do relógio" aparece uma vez só
  internet: false, // hospedando: publica pelo Funnel do Tailscale e os amigos entram só com um link
  nomeServidor: '', // nome que aparece no convite; vazio = "Servidor do <computador>"
  turnCloudflare: { keyId: '', token: '' }, // TURN da Cloudflare: voz de quem está no 4G/CGNAT (ver README)
};
const primeiraVez = !existsSync(arqConfig);
const lerJson = (f, padrao) => { try { return { ...padrao, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch { return { ...padrao }; } };
const config = lerJson(arqConfig, PADRAO);
// o merge acima é raso: arquivo antigo (ou editado à mão) pode não ter o objeto inteiro
const turn = config.turnCloudflare && typeof config.turnCloudflare === 'object' ? config.turnCloudflare : {};
config.turnCloudflare = { keyId: String(turn.keyId ?? ''), token: String(turn.token ?? '') };
if (!existsSync(arqConfig)) writeFileSync(arqConfig, JSON.stringify(PADRAO, null, 2)); // deixa o arquivo pronto para editar
// Variável de ambiente vence o arquivo, como DISCORD_WEBAPP_ENDPOINT vence settings.json no Discord
const endpointExterno = process.env.LIMB_ENDPOINT || config.endpoint;
// Hospedando para amigos, fechar a janela não pode derrubar o servidor deles: o app vai para a bandeja.
// Só entrando no servidor de alguém (ou hospedando só para si), fechar continua fechando.
const hospedandoAmigos = !endpointExterno && (config.compartilharNaRede || config.internet);
const publicando = !endpointExterno && config.internet; // hospedando pela internet (Funnel)
const iniciouOculto = process.argv.includes('--oculto'); // aberto pelo "Iniciar com o Windows"
const salvarConfig = () => writeFileSync(arqConfig, JSON.stringify(config, null, 2));
// Reinicia sem o --oculto (quem pediu a troca está olhando para a tela) e sem o limb:// que abriu o app
// (senão o convite seria perguntado de novo a cada reinício)
// O `funnel` esperando autorização morre junto (no Windows sobreviveria ao app); ao abrir, o app confere de novo.
// "Fecha e não reinicia": a nova instância abria com a trava de instância única ainda presa por esta, achava
// que era a segunda e saía. Por isso solta a trava antes, e espera o servidor embutido largar a porta (no
// máximo 3 s), senão a nova instância pode subir antes e dar "porta em uso".
// ponytail: ainda reinicia o app inteiro; aplicar sem reiniciar fica para a 1.8.1
let reiniciando = false;
async function reiniciar() {
  if (reiniciando) return;
  reiniciando = true;
  tailscale.cancelarEspera();
  const proc = servidor;
  if (proc?.pid) await new Promise((ok) => { proc.once('exit', ok); setTimeout(ok, 3000); proc.kill(); });
  app.releaseSingleInstanceLock();
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--oculto' && !/^limb:/i.test(a)) });
  app.exit(0);
}

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

// limb:// abre este app: é o "Abrir no app" da página de convite. O instalador também registra
// (build.protocols); aqui cobre o portátil e o `npm run desktop` (forma da documentação do Electron).
if (unico) {
  if (process.defaultApp) { if (process.argv.length >= 2) app.setAsDefaultProtocolClient('limb', process.execPath, [path.resolve(process.argv[1])]); }
  else app.setAsDefaultProtocolClient('limb', process.env.PORTABLE_EXECUTABLE_FILE || process.execPath); // portátil: o .exe original
}

// Microfone e tela exigem origem segura. Servidor de outra máquina em http:// não é; o Discord faz igual:
// "Allowing insecure origin" para um WEBAPP_ENDPOINT http que não seja localhost.
if (endpointExterno?.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(endpointExterno + '/')) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', new URL(endpointExterno).origin);
}

let janela = null, servidor = null, janelaConexao = null, erroConexao = null, bandeja = null, saindo = false;

// "Servidor do <computador>": o nome no Tailscale, ou o usuário do Windows
async function nomePadrao() {
  const ts = await tailscale.status().then((st) => st.nome).catch(() => null);
  let usuario = null;
  try { usuario = userInfo().username; } catch {}
  return `Servidor do ${ts || usuario || 'Limb'}`.slice(0, 60);
}

async function subirServidor() {
  // Na internet, qualquer pessoa alcança a página de criar conta: sem código, não sobe aberto
  if (config.internet && !config.codigoConvite) { config.codigoConvite = gerarCodigo(); salvarConfig(); }
  const nome = String(config.nomeServidor || '').trim().slice(0, 60) || await nomePadrao();
  const { keyId, token } = config.turnCloudflare;
  return new Promise((resolve, reject) => {
    servidor = utilityProcess.fork(path.join(raiz, 'server.js'), [], {
      env: {
        ...process.env,
        PORT: String(config.porta),
        // Só pela internet basta 127.0.0.1: o Funnel entrega as conexões localmente
        HOST: config.compartilharNaRede ? '' : '127.0.0.1',
        DB_FILE: path.join(dados, 'limb.db'), // dados ficam no perfil do usuário, não na pasta do app
        INVITE_CODE: config.codigoConvite || '',
        SERVER_NAME: nome,
        ...(keyId && token ? { CF_TURN_KEY_ID: keyId, CF_TURN_API_TOKEN: token } : {}),
        ...(config.iceServers ? { ICE_SERVERS: JSON.stringify(config.iceServers) } : {}),
      },
      stdio: 'inherit',
    });
    // 127.0.0.1, não localhost: localhost pode resolver para ::1 e cair em outro programa na mesma porta
    servidor.on('message', (m) => { if (m?.pronto) resolve(`http://127.0.0.1:${m.pronto}`); });
    servidor.on('exit', (code) => reject(new Error(`O servidor parou (código ${code}). A porta ${config.porta} pode estar em uso por outro programa.`)));
  });
}

// ── Publicação pela internet (Funnel do Tailscale) ────────────────────────────
const abrirNoNavegador = (url) => { shell.openExternal(url); };
// Botão "Ligar o Tailscale" (faixa da janela principal e janela Servidor): sem ele instalado, abre o download
async function ligarTailscale() {
  const st = await tailscale.status();
  if (!st.instalado) { abrirNoNavegador(tailscale.DOWNLOAD); return { baixando: true }; }
  return tailscale.ligar(st.estado, abrirNoNavegador);
}
// publicado = no ar e apontando para o servidor deste app (e não para outra porta)
async function estadoFunnel(porta = config.porta) {
  const f = await tailscale.funnelStatus();
  return { ...f, publicado: f.ativo && f.porta === porta };
}
// Abriu hospedando pela internet: confere e liga se precisar, sem segurar a janela. Não abre o navegador
// sozinho (pode ser o "Iniciar com o Windows"); se faltar autorizar, a faixa da janela principal avisa.
// Enquanto isso, a faixa e o "Convidar amigos" esperam (senão piscariam "desligado" ao abrir).
// "Iniciar com o Windows" costuma abrir antes de o Tailscale ficar Running (e sair pela bandeja tira o Funnel do
// ar): sem conseguir, tenta de novo, cada vez mais devagar (15 s, 30 s… até 5 min). Cada tentativa é curta, porque
// a faixa e o "Convidar amigos" esperam por ela.
let garantindo = null, novaTentativa = null;
function garantirFunnel(espera = 15_000) {
  clearTimeout(novaTentativa);
  const tentativa = (async () => {
    if (saindo || (await estadoFunnel()).publicado) return true;
    const r = await tailscale.ligarFunnel(config.porta, (url) => registrar('o Funnel precisa de autorização:', url));
    if (r.erro) registrar('o Funnel não ligou:', r.erro);
    return !r.erro; // ok, ou esperando autorização: o `funnel --bg` termina sozinho quando o dono autorizar
  })().catch((e) => { registrar('Funnel:', e); return false; });
  garantindo = tentativa.finally(() => { garantindo = null; });
  tentativa.then((ok) => {
    if (!ok && !saindo) novaTentativa = setTimeout(() => garantirFunnel(Math.min(espera * 2, 5 * 60_000)), espera);
  });
}
// Portas que o "Ativar" da janela Servidor publicou e ainda não foram salvas (a que o app já publica não conta).
// Fechar a janela sem salvar tira essas do ar: o `funnel --bg` fica gravado no Tailscale e sobreviveria ao app.
const funnelsDaJanela = new Set();
// Deixou de hospedar pela internet: tira este computador da internet. Só desliga o Funnel que o Limb ligou e
// que aponta para a porta deste servidor (não o de outro programa: quem só entra no servidor de um amigo e
// nunca publicou não tem Funnel do Limb). Melhor esforço: no máximo 6 s, depois segue.
function despublicar(...portas) {
  if (!portas.length && publicando) portas.push(config.porta);
  portas.push(...funnelsDaJanela);
  funnelsDaJanela.clear();
  clearTimeout(novaTentativa); // uma nova tentativa pendente religaria tudo depois que saímos
  if (!portas.length) return Promise.resolve();
  tailscale.cancelarEspera(); // um `funnel` esperando autorização ligaria tudo depois que saímos
  const tentar = async () => {
    const f = await tailscale.funnelStatus();
    if (!f.ativo || !portas.includes(f.porta)) return;
    const r = await tailscale.desligarFunnel();
    if (r.erro) registrar('o Funnel não desligou:', r.erro);
  };
  return Promise.race([tentar().catch((e) => registrar('Funnel:', e)), new Promise((ok) => setTimeout(ok, 6000))]);
}
// A janela Servidor fechou (ou trocou de servidor) sem salvar depois de um "Ativar": não deixa uma porta
// publicada na internet sem o Limb saber. Se ela tinha tirado do ar o que está salvo, põe de volta.
// Fica guardado: se a janela era a última, o app sai logo em seguida e precisa esperar isto terminar.
let largando = null;
function largarFunnelsDaJanela() {
  if (!funnelsDaJanela.size) return largando ?? Promise.resolve();
  const p = largando = despublicar(...funnelsDaJanela).then(() => { if (publicando && !saindo) garantirFunnel(); });
  p.finally(() => { if (largando === p) largando = null; });
  return p;
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
      // Sons da chamada (alguém entrou, menção) tocam mesmo antes do primeiro clique na janela
      autoplayPolicy: 'no-user-gesture-required',
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

  // Só a origem do servidor pode pedir microfone, tela, notificação e escrever na área de transferência
  // (o "Copiar convite")
  const permitido = (wc, perm, url) => ['media', 'display-capture', 'notifications', 'clipboard-sanitized-write'].includes(perm) && new URL(url || wc.getURL()).origin === origem;
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
    // sem o código de cada convite: esta página é do servidor atual, e os convites dos outros não são da conta dele
    const lista = await Promise.all(config.historico.map(async ({ codigo, ...h }) => ({ ...h, online: (await testarServidor(h.url)).ok })));
    return { atual: config.endpoint ?? null, lista };
  });
  // Hospedando com o Tailscale (ou o Funnel) desligado, ninguém de fora consegue entrar, e quem hospeda
  // não percebe: a página consulta isto e mostra uma faixa com o botão de ligar.
  // internet/publicado são novos: páginas antigas só leem instalado/ligado.
  ipcMain.handle('limb:hospedagem', async (e) => {
    if (!daPagina(e) || !hospedandoAmigos) return null;
    await garantindo;
    const st = await tailscale.status();
    const ligado = st.estado === 'Running';
    return { instalado: !!st.instalado, ligado, internet: !!publicando, publicado: publicando && ligado ? (await estadoFunnel()).publicado : null };
  });
  ipcMain.handle('limb:ligarFunnel', (e) => (daPagina(e) && publicando ? tailscale.ligarFunnel(config.porta, abrirNoNavegador) : null));
  // "Convidar amigos": só com o Funnel no ar (link que não abre não é convite)
  ipcMain.handle('limb:convite', async (e) => {
    if (!daPagina(e) || !publicando || !config.codigoConvite) return null;
    await garantindo;
    const f = await estadoFunnel();
    if (!f.publicado) return null;
    const link = linkConvite(f.url, config.codigoConvite);
    return { link, mensagem: mensagemConvite(link) };
  });
  ipcMain.handle('limb:ligarTailscale', (e) => (daPagina(e) ? ligarTailscale() : null));
  ipcMain.handle('limb:trocarServidor', (e, url) => (daPagina(e) ? trocarPara(url == null ? null : String(url)) : { erro: 'negado' }));
  ipcMain.handle('limb:entrarPorConvite', async (e, texto) => {
    if (!daPagina(e)) return { erro: 'negado' };
    const lido = lerConvite(texto);
    if (!lido) return { erro: 'Não achei o link do convite aí. Ele parece com https://alguem.tail1234.ts.net/convite/…' };
    return entrarNoServidor(lido, janela);
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

  // O convite vai no # (não passa pelo servidor no pedido da página); a página guarda e apaga do endereço.
  // No servidor de um amigo, o que veio no link dele; hospedando aqui, o deste servidor: quem hospeda também
  // cria a conta sem digitar nada.
  const convite = endpointExterno ? config.endpoint && config.conviteRecebido : config.codigoConvite;
  janela.loadURL(convite ? `${endpoint}/#convite=${encodeURIComponent(convite)}` : endpoint);
  // aberto por um link de convite: a pergunta do link vem primeiro (a janela Servidor só se ele não der certo)
  if (primeiraVez && !linkPendente) janela.once('ready-to-show', () => abrirConexao());
}

function mostrarJanela() {
  if (!janela || janela.isDestroyed()) return;
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

// ── Bandeja (perto do relógio): só existe hospedando para amigos ────────────────────────────
// O galho do logotipo em PNG 32×32 (scaleFactor 2 = 16 pt na bandeja), o mesmo desenho do build/icon.png
const iconeBandeja = () => nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABRklEQVR42mNgwAE+PY3Q+/Q0ouXT04ijn55GvPv0NOI/ifgdVC/IDD0GYsGnpxFyn55GLCHDQkIYZKYcIct9yfQtKaHii8/y/3TCvtiC/R0dHfAOJTpoFOcE0wRyav8/QFiPAZpNBsoBLQzQvEq0pp3rnf4vmW1FLQccZSA18TnZCf+XlWb9//x2CFwsPVHp/9ReE7ISIwOpmtAdcOeCP5ivrMAOZpNqHsUOAOH6Cm2wWFG22v+3D8Lo54DH14L+97YZ/vd0FQOLwbCFqcD/zkZ92jpgxgTT/2rKHHBLrc0F/4cFSoMtB/HzMlRp6wAYrizS/H/6gCeKGlKigWwHKCmw/9+1wYnirEi2A2ZOMKVKWUC2A26TkeVolg1HHTDkHfBuAB3wblBUxwPeIBnYJtmAN0oHRbN8wDsmg6JrNig6pwPRPQcAgjphnTu15ekAAAAASUVORK5CYII=', 'base64'), { scaleFactor: 2 });

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
    // Cancelou depois de "Ativar": a porta publicada por ela sai da internet (salvou: o reinício cuida)
    const tirar = conexaoSalva ? Promise.resolve() : largarFunnelsDaJanela();
    if (!janela) tirar.finally(() => app.quit()); // aberta sozinha (o app não conseguiu iniciar) e fechada sem salvar
  });
  win.loadFile(path.join(raiz, 'desktop', 'conexao.html'));
}
const daConexao = (e) => janelaConexao && e.sender === janelaConexao.webContents;
let conexaoSalva = false; // "Salvar e reiniciar" deu certo: o que a janela publicou passa a ser o salvo
ipcMain.handle('conexao:ler', async (e) => {
  if (!daConexao(e)) return null;
  const ips = Object.entries(networkInterfaces()).flatMap(([nome, lista]) => (lista ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ nome, endereco: i.address })));
  // O token do TURN não volta para a tela depois de salvo: só o fim dele, para reconhecer
  const { keyId, token } = config.turnCloudflare;
  const cfg = { ...config, turnCloudflare: { keyId, tokenSalvo: !!token, fimDoToken: token.slice(-4) } };
  // Primeira vez de quem recebeu um convite: o que ele copiou já vem preenchido. Da área de transferência
  // só sai o endereço e o código lidos, nunca o texto.
  const colado = primeiraVez && !config.endpoint ? lerConviteCopiado(clipboard.readText()) : null;
  return {
    config: cfg, ips, erro: erroConexao, primeiraVez, portatil: !!process.env.PORTABLE_EXECUTABLE_DIR, podeIniciarComWindows,
    colado, nomePadrao: await nomePadrao(),
  };
});
// Histórico: trocar com um clique (url null = este computador), esquecer, e o "Iniciar com o Windows"
async function trocarPara(url) {
  if (url == null) {
    config.endpoint = null; config.conviteRecebido = '';
    await largarFunnelsDaJanela(); // volta a hospedar com o que está salvo, não com um "Ativar" sem salvar
  } else {
    const h = config.historico.find((x) => x.url === url);
    if (!h) return { erro: 'Esse servidor não está no histórico.' };
    lembrarServidor(h);
    Object.assign(config, { endpoint: h.url, conviteRecebido: h.codigo });
    await despublicar(); // vai para o servidor de outro: este computador sai da internet (se o Limb publicou)
  }
  salvarConfig();
  reiniciar();
  return {};
}

// Entrar no servidor de um amigo por convite (colado na janela principal ou pelo link limb://).
// Endereço novo sempre passa por uma confirmação nativa: nem um servidor nem um link conseguem mandar
// você para outro lugar sem você ver.
let confirmando = false;
// Mesmo servidor, link novo ("Gerar link novo" de quem hospeda): só troca o convite escondido, sem perguntar
// (o servidor é o mesmo) e sem reiniciar. Senão o link antigo voltaria a cada abertura no #convite=.
function trocarConviteRecebido(lido) {
  if (!lido.codigo || lido.codigo === config.conviteRecebido) return { erro: 'Você já está nesse servidor.' };
  config.conviteRecebido = lido.codigo;
  lembrarServidor({ url: lido.url, codigo: lido.codigo });
  salvarConfig();
  if (janela && !janela.isDestroyed()) {
    const wc = janela.webContents;
    // a página tira o #convite do endereço ao ler: mudar só o # não recarrega a página, então recarrega depois
    wc.once('did-navigate-in-page', () => wc.reload());
    wc.loadURL(`${config.endpoint}/#convite=${encodeURIComponent(lido.codigo)}`);
  }
  return {};
}
async function entrarNoServidor(lido, pai) {
  if (confirmando) return { erro: 'Já tem um convite esperando resposta.' };
  if (lido.url === config.endpoint) return trocarConviteRecebido(lido);
  confirmando = true;
  try {
    if (!endpointExterno && await ehEsteComputador(lido.url)) return { erro: 'Esse convite é do seu próprio servidor: você já está nele.' };
    const teste = await testarServidor(lido.url);
    if (!teste.ok) return { erro: teste.erro };
    const { response } = await dialog.showMessageBox(pai && !pai.isDestroyed() ? pai : undefined, {
      type: 'question', buttons: ['Entrar', 'Cancelar'], defaultId: 0, cancelId: 1, title: NOME,
      message: `Entrar no servidor ${teste.nome ? `${teste.nome} (${lido.url})` : lido.url}?`,
      detail: 'O Limb reinicia já conectado a ele. Você volta para cá pela lista de servidores.'
        + (hospedandoAmigos ? '\n\nAtenção: você está hospedando o servidor dos seus amigos. Enquanto estiver no outro, eles ficam sem o seu.' : ''),
    });
    if (response !== 0) return { cancelado: true };
    lembrarServidor({ url: lido.url, codigo: lido.codigo, nome: teste.nome || await nomeNoTailscale(lido.url) });
    Object.assign(config, { endpoint: lido.url, conviteRecebido: lido.codigo });
    salvarConfig();
    await despublicar();
    reiniciar();
    return {};
  } finally { confirmando = false; }
}
// nome do amigo no Tailscale ("pc-do-bruno"), que diz mais do que um 100.x.x.x
const nomeNoTailscale = (url) => tailscale.status().then((st) => st.pares?.find((p) => p.ip === new URL(url).hostname)?.nome ?? null).catch(() => null);
// O próprio link (o do Funnel deste computador) ou o próprio IP: "entrar" nele derrubaria o servidor
async function ehEsteComputador(url) {
  const host = new URL(url).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return true;
  const st = await tailscale.status().catch(() => ({}));
  return !!host && (host === st.ip || host === st.dns?.toLowerCase());
}

// ── Links limb://entrar?servidor=…&convite=… ─────────────────────────────────
// Chegam no argv (ao abrir, ou no 'second-instance' com o app já aberto). Só são tratados com as janelas
// prontas; antes disso, ficam guardados.
const linkDe = (argv) => argv.find((a) => typeof a === 'string' && /^limb:/i.test(a)) ?? null;
let linkPendente = linkDe(process.argv), prontoParaLinks = false;
async function tratarLink() {
  if (!linkPendente || !prontoParaLinks) return;
  const texto = linkPendente;
  linkPendente = null;
  // primeira vez e o link não deu certo: a janela Servidor (que o link pulou) ajuda a seguir
  const ajudar = () => { if (primeiraVez && !janelaConexao) abrirConexao(); };
  const lido = lerDeepLink(texto);
  if (!lido) { registrar('link limb:// ignorado:', texto.slice(0, 300)); return ajudar(); }
  mostrarJanela(); // a pergunta precisa aparecer na frente, mesmo com o app escondido na bandeja
  if (lido.url === config.endpoint) { trocarConviteRecebido(lido); return; } // já está nele: no máximo, um convite novo
  const pai = janela ?? janelaConexao;
  const r = await entrarNoServidor(lido, pai);
  if (r.erro) {
    await dialog.showMessageBox(pai && !pai.isDestroyed() ? pai : undefined, { type: 'warning', title: NOME, message: 'Não deu para entrar pelo convite.', detail: r.erro });
  }
  if (r.erro || r.cancelado) ajudar();
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
ipcMain.handle('conexao:tailscaleLigar', (e) => (daConexao(e) ? ligarTailscale() : null));
ipcMain.handle('conexao:abrirCompartilhar', (e) => { if (daConexao(e)) shell.openExternal(tailscale.PAINEL_MAQUINAS); });
ipcMain.handle('conexao:abrirCloudflare', (e) => { if (daConexao(e)) shell.openExternal('https://dash.cloudflare.com/?to=/:account/calls'); });
// "Gerar link novo" (e o primeiro link de quem vai hospedar): o código nasce aqui, não na página. Vale na hora no
// servidor que está rodando, sem reiniciar: os links antigos param de criar conta, contas e sessões continuam.
ipcMain.handle('conexao:novoConvite', (e) => {
  if (!daConexao(e)) return null;
  config.codigoConvite = gerarCodigo();
  salvarConfig();
  if (servidor && !endpointExterno) {
    try { servidor.postMessage({ convite: config.codigoConvite }); } catch (err) { registrar('convite novo não chegou ao servidor:', err); }
  }
  return { codigo: config.codigoConvite };
});
ipcMain.handle('conexao:copiar', (e, texto) => { if (daConexao(e)) clipboard.writeText(String(texto).slice(0, 2000)); });
ipcMain.handle('conexao:testar', (e, url) => (daConexao(e) ? testarServidor(url) : { ok: false, erro: 'negado' }));
ipcMain.handle('conexao:lerConvite', (e, texto) => {
  const lido = daConexao(e) ? lerConvite(texto) : null;
  return lido && { ...lido, tailscale: ehTailscale(lido.url) };
});
// Publicar pela internet: estado (consultado a cada 3 s) e o botão "Ativar". A porta é a do formulário,
// que vale depois do "Salvar e reiniciar"; ao abrir, o app confere e corrige de qualquer jeito.
const portaValida = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;
ipcMain.handle('conexao:funnel', async (e, porta) => {
  if (!daConexao(e)) return null;
  const p = Math.trunc(Number(porta));
  return estadoFunnel(portaValida(p) ? p : config.porta);
});
ipcMain.handle('conexao:funnelLigar', (e, porta) => {
  if (!daConexao(e)) return null;
  const p = Math.trunc(Number(porta));
  if (!portaValida(p)) return { erro: 'Porta precisa estar entre 1024 e 65535.' };
  // fora do que está salvo (não publicava, ou outra porta): vale só se salvar; fechar sem salvar tira do ar
  if (!(publicando && p === config.porta)) funnelsDaJanela.add(p);
  return tailscale.ligarFunnel(p, abrirNoNavegador);
});
const NAO_RESPONDEU = 'O servidor não respondeu: o computador do seu amigo pode estar desligado ou com o Limb fechado.';
async function testarServidor(url) {
  let origem;
  try { origem = new URL(url).origin; if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { return { ok: false, erro: 'Endereço inválido. Cole o link do convite que seu amigo mandou.' }; }
  try {
    const r = await net.fetch(`${origem}/api/info`, { signal: AbortSignal.timeout(5000) });
    // 502/503/504: o Funnel de quem hospeda está no ar, mas o Limb dele não (fechado ou reiniciando)
    if (r.status >= 502 && r.status <= 504) return { ok: false, erro: NAO_RESPONDEU };
    const info = r.ok ? await r.json().catch(() => null) : null;
    if (!info || typeof info !== 'object' || !('convite' in info)) return { ok: false, erro: 'Respondeu, mas não é um servidor Limb.' };
    // o nome vem do servidor (de quem hospeda): só texto curto, e a tela mostra com textContent
    const nome = typeof info.nome === 'string' ? info.nome.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
    return { ok: true, nome: nome || null };
  } catch {
    // Endereço do Tailscale (100.x): explica o motivo mais provável, olhando o Tailscale
    const host = new URL(origem).hostname;
    if (!ehTailscale(origem)) return { ok: false, erro: NAO_RESPONDEU };
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
const limpar = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
ipcMain.handle('conexao:salvar', async (e, novo) => {
  if (!daConexao(e) || !novo || typeof novo !== 'object') return { erro: 'negado' };
  const porta = Math.trunc(Number(novo.porta));
  if (!portaValida(porta)) return { erro: 'Porta precisa estar entre 1024 e 65535.' };
  let endpoint = null;
  if (novo.modo === 'entrar') {
    try { const u = new URL(String(novo.endpoint)); if (!/^https?:$/.test(u.protocol)) throw 0; endpoint = u.origin; }
    catch { return { erro: 'Endereço inválido. Cole o link do convite que seu amigo mandou.' }; }
  }
  // Opções de hospedar: só mudam ao salvar hospedando (escondidas no "Entrar", não podem travar o salvar)
  const hospedagem = {};
  if (!endpoint) {
    const internet = !!novo.internet;
    // O código do convite nunca vem da página: ela já pediu um (conexao:novoConvite) ao escolher "Hospedar".
    // Sem nenhum, gera aqui. Pela internet qualquer pessoa chega na tela de criar conta e o código é a tranca:
    // um curto, escolhido à mão antes da 1.8, dá lugar a um novo. A janela já troca ao escolher "Pela internet", antes
    // de mostrar o link; isto é só a rede de segurança (se a troca da janela falhou, ainda não havia link para copiar)
    if (!config.codigoConvite || (internet && config.codigoConvite.length < 6)) hospedagem.codigoConvite = gerarCodigo();
    const keyId = limpar(novo.turnKeyId, 200), tokenNovo = limpar(novo.turnToken, 1000);
    const turn = novo.turnRemover ? { keyId: '', token: '' } : { keyId, token: tokenNovo || config.turnCloudflare.token };
    if (turn.keyId && !/^[\w-]{8,128}$/.test(turn.keyId)) return { erro: 'O ID da chave TURN parece errado: copie de novo do painel da Cloudflare.' };
    if (!novo.turnRemover && tokenNovo && !/^[\w.~+/=-]{16,512}$/.test(tokenNovo)) return { erro: 'O token da API parece errado: copie de novo do painel da Cloudflare.' };
    if (!!turn.keyId !== !!turn.token) return { erro: 'Para a voz pelo 4G, preencha os dois: o ID da chave TURN e o token da API (ou remova a chave).' };
    Object.assign(hospedagem, { internet, nomeServidor: limpar(novo.nomeServidor, 60), turnCloudflare: turn });
  }
  const portaAntiga = config.porta;
  Object.assign(config, {
    endpoint, porta, compartilharNaRede: !!novo.compartilharNaRede,
    conviteRecebido: endpoint ? limpar(novo.conviteRecebido, 100) : '',
    ...hospedagem,
  });
  if (endpoint) lembrarServidor({ url: endpoint, codigo: config.conviteRecebido, nome: (await testarServidor(endpoint)).nome || await nomeNoTailscale(endpoint) });
  salvarConfig();
  // Foi para o servidor de um amigo ou trocou a internet pelo Tailscale: tira este computador do ar, se o Limb
  // publicava (despublicar inclui um Funnel ativado agora há pouco nesta janela e não salvo; nunca o de outro programa)
  if (endpoint || !config.internet) await despublicar(...(publicando ? [portaAntiga] : []));
  conexaoSalva = true;
  reiniciar();
  return {};
});

// Abrir o atalho de novo traz a janela, mesmo escondida na bandeja; um link limb:// chega por aqui
// quando o app já está aberto
app.on('second-instance', (_e, argv) => {
  mostrarJanela();
  if (!janela && janelaConexao) janelaConexao.focus();
  const link = linkDe(argv);
  if (link) { linkPendente = link; tratarLink(); }
});
app.on('window-all-closed', () => { if (!bandeja) app.quit(); });
// Fechando de vez hospedando pela internet (ou com um "Ativar" da janela Servidor ainda sem salvar): tira do ar
// antes (se outro programa usar esta porta depois, ele não fica publicado na internet). Espera no máximo os 6 s
// do despublicar.
let despublicouAoSair = false;
app.on('before-quit', (e) => {
  saindo = true;
  // !unico: é a segunda instância saindo logo ao abrir; o Funnel é da primeira, que continua no ar
  if (!unico || !(publicando || funnelsDaJanela.size || largando) || despublicouAoSair) return;
  despublicouAoSair = true;
  e.preventDefault();
  Promise.all([despublicar(), largando]).finally(() => app.quit());
});
app.on('quit', () => { servidor?.kill(); tailscale.cancelarEspera(); });

app.whenReady().then(async () => {
  if (!unico) return;
  try {
    criarJanela(endpointExterno || await subirServidor());
    if (hospedandoAmigos) { criarBandeja(); aplicarInicioComWindows(); }
    if (publicando) garantirFunnel(); // em segundo plano: a janela não espera o Tailscale
  } catch (e) {
    // não fecha o app: deixa trocar a porta ou entrar no servidor de outra pessoa
    abrirConexao(`Não foi possível iniciar o servidor: ${e.message}`);
    // a porta pode ser de outro programa: um Funnel ligado de antes o publicaria na internet
    if (publicando) despublicar();
  }
  prontoParaLinks = true;
  tratarLink();
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
