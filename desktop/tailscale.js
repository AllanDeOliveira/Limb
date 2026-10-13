// Integração com o Tailscale instalado na máquina, pela linha de comando dele.
// Não embute o Tailscale: a voz/tela (WebRTC do Chromium) só usa a rede 100.x se o cliente oficial estiver instalado.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

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

// { instalado, estado: 'Running'|'NeedsLogin'|'Stopped'|'Starting'|..., ip, nome, conta, pares: [{ ip, nome, online }] }
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
