// Lógica pura do convite e do Funnel (sem electron): dá para testar com `node --test` (desktop-convite.test.js).
// lerConvite tem uma cópia em conexao.js (lerColado), que é script comum da janela e não importa módulos:
// mudou uma, mude a outra.
import { randomInt } from 'node:crypto';

// Ninguém digita o código (ele vai dentro do link): 12 caracteres, ~59 bits. Sem 0/o, 1/l/i mesmo assim: se
// alguém um dia precisar ditar, não confunde.
const LETRAS = 'abcdefghjkmnpqrstuvwxyz23456789';
export const gerarCodigo = () => Array.from({ length: 12 }, () => LETRAS[randomInt(LETRAS.length)]).join('');

const MAX_CODIGO = 100;
const controle = /[\u0000-\u001f\u007f]/;
// "https://x.ts.net/convite/abc." no fim da frase: a pontuação não faz parte do link
const semPontuacaoFinal = (s) => s.replace(/[.,;:!?*_~]+$/, '');
const decodificar = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
const codigoValido = (c) => typeof c === 'string' && c.length <= MAX_CODIGO && !controle.test(c);

// Link do convite e mensagem pronta para colar no WhatsApp/Discord
export const linkConvite = (origem, codigo) => `${origem}/convite/${encodeURIComponent(codigo)}`;
export const deepLink = (origem, codigo) => `limb://entrar?servidor=${encodeURIComponent(origem)}&convite=${encodeURIComponent(codigo)}`;
export const mensagemConvite = (link) => `Bora conversar no Limb! 🎧\nEntra por aqui: ${link}\n(Abre no navegador ou baixa o app. Não precisa de Tailscale.)`;

// limb://entrar?servidor=<origem>&convite=<código>: o "Abrir no app" da página de convite.
// Estrito porque vem de fora (qualquer página pode abrir um limb://): só http(s), só a origem, código curto.
export function lerDeepLink(texto) {
  const t = String(texto ?? '').trim();
  if (t.length > 2000) return null;
  let u;
  try { u = new URL(t); } catch { return null; }
  // o Windows/navegador às vezes acrescenta a barra: limb://entrar/?…
  if (u.protocol !== 'limb:' || u.hostname !== 'entrar' || !['', '/'].includes(u.pathname) || u.username || u.password) return null;
  const servidor = u.searchParams.get('servidor'), codigo = u.searchParams.get('convite') ?? '';
  if (!servidor || !codigoValido(codigo)) return null;
  let s;
  try { s = new URL(servidor); } catch { return null; }
  if (!/^https?:$/.test(s.protocol) || s.username || s.password || s.pathname !== '/' || s.search || s.hash) return null;
  return { url: s.origin, codigo };
}

// Convite colado ou copiado: o link https://host/convite/<código>, um limb://entrar, a mensagem inteira
// do convite antigo ("Endereço: http://100.x:3000 / Código de convite: x"), só a URL, ou só "100.x.x.x:3000".
export function lerConvite(texto) {
  const t = String(texto ?? '').slice(0, 2000);
  const deep = /limb:\/\/\S+/i.exec(t);
  if (deep) { const d = lerDeepLink(semPontuacaoFinal(deep[0])); if (d) return d; }
  const urls = (t.match(/https?:\/\/[^\s<>"'()]+/gi) ?? []).map(semPontuacaoFinal);
  // a mensagem pode ter outros links (download do app): o de /convite/ vence
  let bruto = urls.find((x) => /^https?:\/\/[^/]+\/convite\/[^/?#]+/i.test(x)) ?? urls[0];
  if (!bruto) {
    // sem http: "x.tailnet.ts.net/convite/abc" (o endereço do Funnel é sempre https) ou "100.x.x.x:3000"
    const tsnet = /\b((?:[a-z0-9-]+\.)+ts\.net)(\/convite\/[^\s<>"'()]+)?/i.exec(t);
    if (tsnet) bruto = semPontuacaoFinal(`https://${tsnet[1]}${tsnet[2] ?? ''}`);
    else { const m = /\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?\b/.exec(t); if (m) bruto = `http://${m[1]}:${m[2] ?? 3000}`; }
  }
  let u;
  try { u = new URL(bruto); } catch { return null; }
  let codigo = null;
  const caminho = /^\/convite\/([^/]+)\/?$/.exec(u.pathname);
  if (caminho) codigo = decodificar(caminho[1]);
  if (codigo == null) { const h = /[#&]convite=([^&]+)/.exec(u.hash); if (h) codigo = decodificar(h[1]); }
  if (codigo == null) codigo = /c[óo]digo[^:\n]*:\s*(\S+)/i.exec(t)?.[1] ?? '';
  return { url: u.origin, codigo: codigoValido(codigo) ? codigo : '' };
}

// O que a pessoa tinha copiado ao abrir o app pela primeira vez: só conta se for mesmo um convite do Limb
// (link /convite/, limb://, a mensagem que o Limb gera, de qualquer versão, ou o "Código de convite:" da antiga).
// Qualquer outro link copiado não vira "Entrar", nem o do download (github.com/…/Limb/releases tem "Limb").
export function lerConviteCopiado(texto) {
  const t = String(texto ?? '').slice(0, 2000);
  if (!/limb:\/\/entrar|https?:\/\/[^\s/]+\/convite\/|\bBora conversar no Limb\b|c[óo]digo de convite\s*:/i.test(t)) return null;
  return lerConvite(t);
}

// Endereço da rede do Tailscale (100.64.0.0/10): só nesse caso o amigo precisa do Tailscale para entrar
export function ehTailscale(url) {
  try {
    const [a, b] = new URL(url).hostname.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  } catch { return false; }
}

// `tailscale funnel status --json` imprime o ServeConfig:
// { TCP: { "443": { HTTPS: true } }, Web: { "host:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
//   AllowFunnel: { "host:443": true } }; desligado, imprime {}.
// porta = a porta local para onde a raiz "/" do Funnel aponta (null se aponta para outro lugar).
export function lerFunnelStatus(json) {
  const desligado = { ativo: false, url: null, porta: null };
  let d;
  try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return desligado; }
  if (!d || typeof d !== 'object') return desligado;
  for (const [hostPorta, permitido] of Object.entries(d.AllowFunnel ?? {})) {
    const m = /^(.+):443$/.exec(hostPorta);
    if (permitido !== true || !m) continue;
    const proxy = d.Web?.[hostPorta]?.Handlers?.['/']?.Proxy;
    return { ativo: true, url: `https://${m[1]}`, porta: portaLocal(proxy) };
  }
  return desligado;
}
function portaLocal(proxy) {
  if (typeof proxy !== 'string') return null;
  if (/^\d+$/.test(proxy)) return Number(proxy);
  try {
    const u = new URL(proxy);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && u.port ? Number(u.port) : null;
  } catch { return null; }
}

// A URL de autorização que o `tailscale funnel` imprime quando o Funnel/HTTPS ainda não foi liberado
// ("To enable, visit: https://login.tailscale.com/f/funnel?node=…"). Só vale a URL inteira: a saída chega
// em pedaços, e a quebra de linha depois dela garante que não foi cortada no meio.
export function urlDeLogin(saida) {
  const m = /https:\/\/login\.tailscale\.com\/\S+(?=\s)/.exec(String(saida ?? ''));
  return m ? semPontuacaoFinal(m[0]) : null;
}

// Erro do `tailscale funnel` em português, com a frase original no fim (ajuda a pesquisar)
export function explicarErroFunnel(saida, acao = 'publicar') {
  const texto = String(saida ?? '');
  const linha = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? '';
  if (/failed to connect|is tailscaled running|not running|connection refused|NeedsLogin|logged out|not logged in/i.test(texto)) {
    return 'O Tailscale não está ligado neste computador: ligue no passo 1.';
  }
  if (/access denied|permission denied|operator/i.test(texto)) {
    return `O Tailscale não deixou o Limb mudar a configuração dele. Abra o aplicativo do Tailscale e tente de novo. (${linha})`;
  }
  return linha ? `O Tailscale não conseguiu ${acao}: ${linha}` : `O Tailscale não conseguiu ${acao}. Tente de novo em instantes.`;
}
