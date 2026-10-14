// Integração com o Tailscale instalado na máquina, pela linha de comando dele.
// Não embute o Tailscale: a voz/tela (WebRTC do Chromium) só usa a rede 100.x se o cliente oficial estiver instalado.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { explicarErroFunnel, lerFunnelStatus, urlDeLogin } from './convite.js';

export const DOWNLOAD = 'https://tailscale.com/download';
export const PAINEL_MAQUINAS = 'https://login.tailscale.com/admin/machines';

const pastaWin = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale');

function exe() {
  if (process.platform === 'win32' && existsSync(path.join(pastaWin, 'tailscale.exe'))) return path.join(pastaWin, 'tailscale.exe');
  if (process.platform === 'darwin' && existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')) {
    return '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  }
  return 'tailscale'; // no PATH (Linux)
}

function abrirApp() {
  const gui = path.join(pastaWin, 'tailscale-ipn.exe');
  if (process.platform === 'win32' && existsSync(gui)) spawn(gui, [], { detached: true, stdio: 'ignore' }).unref();
}

const ipv4 = (lista) => (lista ?? []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;

// { instalado, estado: 'Running'|'NeedsLogin'|'Stopped'|'Starting'|..., ip, nome, dns, conta, pares: [{ ip, nome, online }] }
export function status() {
  return new Promise((resolve) => {
    execFile(exe(), ['status', '--json'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err?.code === 'ENOENT') return resolve({ instalado: false });
      let d;
      try { d = JSON.parse(stdout); } catch { return resolve({ instalado: true, estado: 'Indisponivel' }); } // serviço parado
      const eu = d.Self ?? {};
      resolve({
        instalado: true,
        estado: d.BackendState,
        ip: ipv4(eu.TailscaleIPs ?? d.TailscaleIPs),
        nome: eu.HostName ?? null,
        dns: eu.DNSName?.replace(/\.$/, '') || null, // "maquina.tailnet.ts.net": o endereço do Funnel
        conta: d.CurrentTailnet?.Name ?? null,
        pares: Object.values(d.Peer ?? {}).map((p) => ({ ip: ipv4(p.TailscaleIPs), nome: p.HostName, online: !!p.Online })),
      });
    });
  });
}

// Sem login: `tailscale login` imprime a URL de login e espera; a URL abre no navegador.
// Desligado: `tailscale up`. Se ele recusar (preferências mudadas no app do Tailscale), abre o app dele.
export function ligar(estado, abrirUrl) {
  return new Promise((resolve) => {
    if (estado === 'Indisponivel') { abrirApp(); return resolve({ erro: 'Abri o aplicativo do Tailscale: clique em Connect (Conectar) nele.' }); }
    const p = spawn(exe(), [estado === 'NeedsLogin' ? 'login' : 'up'], { windowsHide: true });
    let saida = '', aberto = false;
    const ler = (b) => {
      saida += b;
      const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(saida)?.[0];
      if (url && !aberto) { aberto = true; abrirUrl(url); resolve({ login: true }); }
    };
    p.stdout.on('data', ler);
    p.stderr.on('data', ler);
    p.on('error', () => resolve({ erro: 'Tailscale não encontrado' }));
    p.on('exit', (code) => {
      if (code === 0) return resolve({ ok: true });
      abrirApp();
      resolve({ erro: 'Abri o aplicativo do Tailscale: clique em Connect (Conectar) nele.' });
    });
    setTimeout(() => { if (!aberto) resolve({ esperando: true }); }, 8000);
    setTimeout(() => p.kill(), 10 * 60_000); // login abandonado
  });
}

// ── Funnel: publica o servidor deste computador na internet ──────────────────
// O tailscaled daqui atende https://<máquina>.<tailnet>.ts.net (com certificado) e repassa para
// http://127.0.0.1:<porta>. Quem entra não precisa de Tailscale; só este computador precisa.
// Uma operação por vez: ligar e desligar mexem na mesma configuração do tailscaled.
let fila = Promise.resolve();
const emFila = (op) => { const p = fila.then(op); fila = p.catch(() => {}); return p; };
let esperando = null; // { proc, porta, url }: o `funnel --bg` rodando (com url: parado até o dono clicar em Enable)

const NAO_INSTALADO = { erro: 'O Tailscale não está instalado neste computador: instale no passo 1.' };
const DESLIGADO = { erro: 'O Tailscale não está ligado neste computador: ligue no passo 1.' };

// { ativo, url: 'https://maquina.tailnet.ts.net' | null, porta: porta local da raiz | null, erro? }
export function funnelStatus() {
  return new Promise((resolve) => {
    execFile(exe(), ['funnel', 'status', '--json'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ...lerFunnelStatus(null), erro: err.code === 'ENOENT' ? NAO_INSTALADO.erro : DESLIGADO.erro });
      resolve(lerFunnelStatus(stdout));
    });
  });
}

// Na primeira vez a tailnet ainda não liberou Funnel/HTTPS: o comando imprime um link de autorização e
// ESPERA. O link abre uma vez no navegador e a resposta volta na hora ({ autorizar }); o processo continua
// e termina sozinho quando o dono clica em Enable (quem chamou descobre consultando funnelStatus).
export function ligarFunnel(porta, abrirUrl) {
  return emFila(async () => {
    if (esperando?.porta === porta) {
      if (!esperando.url) return { erro: 'O Tailscale ainda está respondendo. Tente de novo em instantes.' };
      abrirUrl(esperando.url); // pediu de novo: talvez tenha fechado a aba sem autorizar
      return { autorizar: true };
    }
    cancelarEspera();
    const st = await status();
    if (!st.instalado) return NAO_INSTALADO;
    if (st.estado !== 'Running') return DESLIGADO;
    return new Promise((resolve) => {
      const p = spawn(exe(), ['funnel', '--bg', '--yes', String(porta)], { windowsHide: true });
      const eu = esperando = { proc: p, porta, url: null };
      let saida = '', respondeu = false;
      const responder = (r) => { if (!respondeu) { respondeu = true; resolve(r); } };
      const ler = (b) => {
        saida = (saida + b).slice(-8000);
        if (eu.url || !(eu.url = urlDeLogin(saida))) return;
        abrirUrl(eu.url);
        responder({ autorizar: true });
      };
      p.stdout.on('data', ler);
      p.stderr.on('data', ler);
      const limite = setTimeout(() => p.kill(), 10 * 60_000); // autorização abandonada
      // nem link nem resposta: devolve o controle, e o processo segue sendo "o que está esperando"
      const lento = setTimeout(() => { responder({ erro: 'O Tailscale está demorando para responder. Tente de novo em instantes.' }); }, 30_000);
      const fim = () => { clearTimeout(limite); clearTimeout(lento); if (esperando === eu) esperando = null; };
      p.on('error', (e) => { fim(); responder(e.code === 'ENOENT' ? NAO_INSTALADO : { erro: explicarErroFunnel(e.message) }); });
      p.on('close', async (codigo) => {
        fim();
        if (respondeu) return;
        if (codigo !== 0) return responder({ erro: explicarErroFunnel(saida) });
        responder({ ok: true, url: (await funnelStatus()).url });
      });
    });
  });
}

// O app vai fechar ou trocar de servidor: no Windows o processo filho sobreviveria ao app e, se alguém
// clicasse em Enable depois, publicaria uma porta que já não é do Limb
export function cancelarEspera() {
  esperando?.proc.kill();
  esperando = null;
}

// "Para desligar, repita o comando que ligou com off no fim". Nada de `funnel reset`: apagaria outras
// configurações de serve/funnel que a pessoa tenha neste computador.
export function desligarFunnel() {
  return emFila(() => new Promise((resolve) => {
    cancelarEspera();
    execFile(exe(), ['funnel', '--https=443', 'off'], { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      resolve(err.code === 'ENOENT' ? NAO_INSTALADO : { erro: explicarErroFunnel(`${stdout}${stderr}`, 'desligar a publicação') });
    });
  }));
}
