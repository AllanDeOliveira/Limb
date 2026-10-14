// Servidor estilo Discord: REST (/api) para escrever, Gateway (WebSocket /gateway)
// para receber eventos em tempo real. Mesmo fluxo observado no cliente oficial:
// HELLO(10) → IDENTIFY(2) → DISPATCH(0) READY; HEARTBEAT(1) ↔ HEARTBEAT_ACK(11);
// reconexão: RESUME(6) {token, session_id, seq} → eventos perdidos + RESUMED, ou INVALID_SESSION(9).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { snowflake, parseSearch, searchToSql } from './lib.js';
import { criarVoz } from './voice.js';

const PORT = Number(process.env.PORT ?? 3000); // PORT=0 = porta livre qualquer (testes)
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url)); // relativo ao arquivo: funciona dentro do app empacotado
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, VOICE_STATE_UPDATE: 4, RESUME: 6, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
const CANAL = { TEXTO: 0, VOZ: 2 }; // GUILD_TEXT=0, GUILD_VOICE=2 no bundle do Discord
const HEARTBEAT_INTERVAL = 41250; // valor que o gateway real anuncia no HELLO
const RESUME_WINDOW = Number(process.env.RESUME_WINDOW_MS) || 45_000; // sessão sem socket espera isso por um RESUME
const REPLAY_MAX = 1000; // eventos guardados por sessão para reenviar no RESUME
const MAX_REACOES = 20; // emojis distintos por mensagem (limite do Discord)
const SESSAO_TTL = 30 * 86_400_000; // sessão de login expira depois de 30 dias sem uso
const MAX_SESSOES = 50; // por conta: logins além disso derrubam os mais antigos
// package.json vai junto no app empacotado: a página de convite aponta para o instalador desta mesma versão
const VERSAO = (() => { try { return String(JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version ?? ''); } catch { return ''; } })();
// Nome que aparece no convite ("Você foi convidado para…"); Array.from não corta um emoji ao meio
const NOME_SERVIDOR = Array.from(String(process.env.SERVER_NAME ?? '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('').trim() || 'Limb';

// ── Banco ───────────────────────────────────────────────────────────────────
// ids são snowflakes (INTEGER 64 bits) → readBigInts, e viram string no JSON, como na API do Discord
const db = new DatabaseSync(process.env.DB_FILE || 'limb.db', { readBigInts: true });
// WAL: leituras não esperam escritas; NORMAL é seguro com WAL e evita um fsync por mensagem
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS guilds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER);
  CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL REFERENCES guilds(id), name TEXT NOT NULL,
    type INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id),
    author_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL, edited_timestamp TEXT);
  CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, emoji, user_id));
  CREATE TABLE IF NOT EXISTS read_states (
    user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL,
    last_message_id INTEGER NOT NULL DEFAULT 0, mention_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id));
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), token_hash TEXT UNIQUE NOT NULL,
    criado INTEGER NOT NULL, usado INTEGER NOT NULL, expira INTEGER NOT NULL, dispositivo TEXT NOT NULL DEFAULT '', ip TEXT);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
`);
// Bancos criados pela versão anterior não têm estas colunas
const colunas = db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((c) => c.name);
if (!colunas.includes('reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
if (!colunas.includes('mentions')) db.exec("ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'");
// senha: 'scrypt$N$r$p$sal$hash' (antes: 'sal:hash'). null = conta antiga, do tempo em que só o nome bastava
if (!db.prepare("SELECT name FROM pragma_table_info('users')").all().some((c) => c.name === 'senha')) db.exec('ALTER TABLE users ADD COLUMN senha TEXT');

const q = (sql) => db.prepare(sql);
// v1: o token fixo de cada conta (users.token) vira a primeira sessão dela, para ninguém precisar entrar
// de novo; a coluna fica com um valor aleatório que nunca é devolvido nem aceito (é NOT NULL UNIQUE)
if (Number(q('PRAGMA user_version').get().user_version) < 1) {
  db.exec('BEGIN');
  try {
    const agora = Date.now();
    for (const u of q('SELECT id, token FROM users').all()) {
      q(`INSERT OR IGNORE INTO sessions (id, user_id, token_hash, criado, usado, expira, dispositivo) VALUES (?, ?, ?, ?, ?, ?, 'Sessão anterior')`)
        .run(snowflake(), u.id, hashToken(u.token), agora, agora, agora + SESSAO_TTL);
      q('UPDATE users SET token = ? WHERE id = ?').run(tokenAleatorio(), u.id);
    }
    db.exec('PRAGMA user_version = 1; COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
if (!q("SELECT name FROM pragma_table_info('channels')").all().some((c) => c.name === 'type')) {
  db.exec('ALTER TABLE channels ADD COLUMN type INTEGER NOT NULL DEFAULT 0');
  // servidores que já existiam ganham um canal de voz, como os novos
  for (const g of q('SELECT id FROM guilds').all()) criarCanal(g.id, 'Sala de voz', CANAL.VOZ);
}
if (!q('SELECT 1 FROM guilds').get()) criarGuild('Limb', null);

function criarGuild(name, ownerId) {
  const id = snowflake();
  q('INSERT INTO guilds VALUES (?, ?, ?)').run(id, name, ownerId);
  criarCanal(id, 'geral', CANAL.TEXTO);
  criarCanal(id, 'Sala de voz', CANAL.VOZ); // "Geral" de voz confundia com o #geral de texto
  return guildPayload(id);
}
function criarCanal(guildId, name, type) {
  const c = { id: snowflake(), guild_id: guildId, name, type, last_message_id: null };
  q('INSERT INTO channels (id, guild_id, name, type) VALUES (?, ?, ?, ?)').run(c.id, c.guild_id, c.name, c.type);
  return c;
}
function guildPayload(id) {
  const g = q('SELECT * FROM guilds WHERE id = ?').get(id);
  return g && { ...g, channels: q(`SELECT c.*, (SELECT max(id) FROM messages WHERE channel_id = c.id) AS last_message_id
    FROM channels c WHERE guild_id = ? ORDER BY id`).all(id).map((c) => ({ ...c, type: Number(c.type) })) }; // tipo é número, não id
}

const MSG_SELECT = `SELECT m.*, c.guild_id, u.name AS author_name,
    r.id AS ref_id, r.content AS ref_content, r.author_id AS ref_author_id, ru.name AS ref_author_name
  FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.author_id
  LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.author_id`;
// Mesmo formato da API do Discord: message_reference aponta, referenced_message traz o conteúdo (null se apagada)
const messagePayload = (r) => r && ({
  id: r.id, channel_id: r.channel_id, guild_id: r.guild_id, content: r.content,
  edited_timestamp: r.edited_timestamp, author: { id: r.author_id, username: r.author_name },
  mentions: JSON.parse(r.mentions),
  message_reference: r.reply_to ? { message_id: r.reply_to, channel_id: r.channel_id } : undefined,
  referenced_message: r.reply_to
    ? (r.ref_id ? { id: r.ref_id, content: r.ref_content, author: { id: r.ref_author_id, username: r.ref_author_name } } : null)
    : undefined,
  reactions: [],
});
const getMessage = (id) => messagePayload(q(`${MSG_SELECT} WHERE m.id = ?`).get(id));

// reactions: [{ emoji, count, me }] — "me" depende de quem pede, então só no REST
function comReacoes(msgs, viewerId) {
  if (!msgs.length) return msgs;
  const rows = q(`SELECT message_id, emoji, count(*) AS n, max(user_id = ?) AS me FROM reactions
    WHERE message_id IN (${msgs.map(() => '?').join()}) GROUP BY message_id, emoji ORDER BY min(rowid)`)
    .all(viewerId, ...msgs.map((m) => m.id));
  const por = new Map(msgs.map((m) => [String(m.id), m]));
  for (const r of rows) por.get(String(r.message_id)).reactions.push({ emoji: r.emoji, count: Number(r.n), me: r.me === 1n });
  return msgs;
}

// @nome no texto → ids dos usuários que existem (como o array `mentions` do Discord)
function mencoes(content) {
  const nomes = [...new Set([...content.matchAll(/@([a-z0-9_.]{2,32})/gi)].map((m) => m[1].toLowerCase()))].slice(0, 50);
  if (!nomes.length) return [];
  return q(`SELECT id FROM users WHERE name IN (${nomes.map(() => '?').join()})`).all(...nomes).map((r) => String(r.id));
}

// Nomes como no Discord: usuário [a-z0-9_.]{2,32}; canal em minúsculas com hífens
const nomeCanal = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 100);

// ── Gateway ─────────────────────────────────────────────────────────────────
// Sessão sobrevive ao socket: guarda seq e os últimos eventos para o RESUME.
const sessions = new Map(); // session_id → { id, user, auth, seq, ws, buffer, expira }; auth = id da sessão de login
const online = () => [...new Set([...sessions.values()].map((s) => s.user.id))];

function send(s, payload) {
  if (s.ws?.readyState === 1) s.ws.send(json(payload));
}
function dispatch(s, t, d) {
  const p = { op: OP.DISPATCH, t, s: ++s.seq, d };
  s.buffer.push(p);
  if (s.buffer.length > REPLAY_MAX) s.buffer.shift();
  send(s, p);
}
// ponytail: todo mundo vê todos os servidores; com permissões, filtrar por membro aqui
const broadcast = (t, d) => { for (const s of sessions.values()) dispatch(s, t, d); };
const paraUsuario = (userId, t, d) => { for (const s of sessions.values()) if (s.user.id === userId) dispatch(s, t, d); };
const presence = (user, status) => broadcast('PRESENCE_UPDATE', { user, status });

const voz = criarVoz({
  broadcast,
  iceServers: iceAtual, // a cada READY: as credenciais do TURN vencem
  paraSessao: dispatch,
  canalDeVoz: (id) => idValido(id) && q('SELECT * FROM channels WHERE id = ? AND type = ?').get(BigInt(id), CANAL.VOZ),
});

function encerrar(s) {
  clearTimeout(s.expira);
  if (!sessions.delete(s.id)) return;
  voz.sair(s);
  if (!online().includes(s.user.id)) presence(s.user, 'offline');
}

function readyPayload(s) {
  return {
    session_id: s.id,
    user: s.user,
    guilds: q('SELECT id FROM guilds ORDER BY id').all().map((g) => guildPayload(g.id)),
    users: q('SELECT id, name AS username FROM users').all(),
    presences: online(),
    read_state: q('SELECT channel_id, last_message_id, mention_count FROM read_states WHERE user_id = ?').all(s.user.id)
      .map((r) => ({ ...r, mention_count: Number(r.mention_count) })), // contador é número, não id
    voice_states: [...voz.estados.values()],
  };
}

function gateway(ws) {
  // Frame grande demais ou UTF-8 inválido: o ws emite 'error' no socket (e já fecha com o código certo).
  // Sem ouvinte, o 'error' derrubava o servidor de todo mundo.
  ws.on('error', () => {});
  let s = null, timer;
  // Cliente que não manda heartbeat no prazo é zumbi: fecha (código 4009 = session timed out)
  const vigiar = () => { clearTimeout(timer); timer = setTimeout(() => ws.close(4009, 'Session timed out'), HEARTBEAT_INTERVAL * 1.5); };
  vigiar();
  // Quem não se identifica em 30 s não é o app: fecha, em vez de ocupar um socket para sempre só com heartbeats
  const semLogin = setTimeout(() => { if (!s) ws.close(4003, 'Not authenticated'); }, 30_000);
  ws.on('close', () => clearTimeout(semLogin));
  send({ ws }, { op: OP.HELLO, d: { heartbeat_interval: HEARTBEAT_INTERVAL } });

  ws.on('message', (raw) => {
    try { receber(raw); } catch (e) { console.error('[gateway]', e); ws.close(4000, 'Erro'); } // nunca derruba o servidor
  });
  function receber(raw) {
    let p;
    try { p = JSON.parse(raw); } catch { return ws.close(4002, 'Decode error'); }
    if (!p || typeof p !== 'object' || Array.isArray(p)) return ws.close(4002, 'Decode error'); // "null", "1", "[]"…
    if (p.op === OP.HEARTBEAT) { vigiar(); return send({ ws }, { op: OP.HEARTBEAT_ACK }); }
    if (s) {
      if (s.ws !== ws) return; // sessão revogada (ou retomada noutro socket): este já está fechando
      if (p.op === OP.VOICE_STATE_UPDATE) {
        const erro = voz.atualizarEstado(s, p.d);
        if (erro) dispatch(s, 'VOICE_STATE_ERROR', { message: erro }); // ponytail: o Discord só ignora
      }
      return;
    }

    if (p.op === OP.IDENTIFY) {
      const auth = autenticar(p.d?.token);
      if (!auth) return ws.close(4004, 'Authentication failed');
      const { user } = auth;
      const jaOnline = online().includes(user.id);
      s = { id: randomBytes(16).toString('hex'), user, auth: auth.sessao, seq: 0, ws, buffer: [], expira: null };
      sessions.set(s.id, s);
      dispatch(s, 'READY', readyPayload(s));
      if (!jaOnline) presence(user, 'online');
      return;
    }

    if (p.op === OP.RESUME) {
      const old = sessions.get(String(p.d?.session_id));
      const auth = autenticar(p.d?.token);
      const seq = Number(p.d?.seq);
      const perdidos = old?.buffer.filter((e) => e.s > seq) ?? [];
      // Só retoma com o mesmo login (token revogado ou expirado não volta), a sessão sem socket e o buffer cobrindo tudo depois de `seq`
      const cobre = old && seq <= old.seq && (perdidos.length ? perdidos[0].s === seq + 1 : seq === old.seq);
      if (!old || !auth || auth.sessao !== old.auth || old.ws || !cobre) {
        return send({ ws }, { op: OP.INVALID_SESSION, d: false }); // cliente faz IDENTIFY de novo
      }
      clearTimeout(old.expira);
      s = old;
      s.ws = ws;
      for (const e of perdidos) send(s, e);
      dispatch(s, 'RESUMED', {});
      return;
    }
    ws.close(4003, 'Not authenticated');
  }

  ws.on('close', (code) => {
    clearTimeout(timer);
    if (!s || s.ws !== ws) return;
    s.ws = null;
    // 1000 = saiu de propósito; 4009 = zumbi. Os demais (aba fechada, rede caiu) podem retomar.
    if (code === 1000 || code === 4009) encerrar(s);
    else s.expira = setTimeout(() => encerrar(s), RESUME_WINDOW);
  });
}

// ── REST ────────────────────────────────────────────────────────────────────
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
// Snowflake cabe em 64 bits com sinal: "99999999999999999999" passa no /\d{1,20}/, mas o SQLite recusa o BigInt
// (e no gateway a exceção derrubava o servidor)
function idValido(v) { return typeof v === 'string' && /^\d{1,19}$/.test(v) && BigInt(v) <= 2n ** 63n - 1n; }
const id64 = (v) => { if (!idValido(v ?? '')) throw new HttpError(400, 'id inválido'); return BigInt(v); };
const conteudo = (v) => {
  const c = String(v ?? '').trim();
  if (!c || c.length > 2000) throw new HttpError(400, 'Mensagem precisa ter de 1 a 2000 caracteres');
  return c;
};
function emoji(raw) {
  let e;
  try { e = decodeURIComponent(raw); } catch { throw new HttpError(400, 'Emoji inválido'); }
  if (!/^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]{1,16}$/u.test(e)) throw new HttpError(400, 'Emoji inválido');
  return e;
}
function canal(cid) {
  const c = q('SELECT * FROM channels WHERE id = ?').get(id64(cid));
  if (!c) throw new HttpError(404, 'Canal não encontrado');
  return c;
}
function mensagemDoCanal(cid, mid) {
  const m = q('SELECT * FROM messages WHERE id = ? AND channel_id = ?').get(id64(mid), id64(cid));
  if (!m) throw new HttpError(404, 'Mensagem não encontrada');
  return m;
}
function minhaMensagem(cid, mid, user) {
  const m = mensagemDoCanal(cid, mid);
  if (m.author_id !== user.id) throw new HttpError(403, 'Só o autor pode alterar');
  return m;
}

// ── Contas ──────────────────────────────────────────────────────────────────
// O código vai escondido dentro do link (/convite/<código>, #convite=<código>): ninguém digita, mas ele
// continua sendo a tranca de quem cria conta num servidor que agora pode estar na internet.
// Vazio = qualquer um que alcance o servidor cria conta.
let codigoConvite = process.env.INVITE_CODE || '';
// "Gerar link novo" no app desktop (utilityProcess) manda { convite: '<código novo>' }: vale na hora, sem
// reiniciar. Contas e sessões continuam; só os links antigos param de criar conta. Outras mensagens não são para cá.
function receberDoApp(m) {
  const novo = typeof m?.convite === 'string' ? m.convite.trim() : '';
  if (novo && novo.length <= 100 && !/[\u0000-\u001f\u007f]/.test(novo)) codigoConvite = novo;
}
if (process.parentPort) process.parentPort.on('message', (e) => receberDoApp(e.data));
else if (process.send) process.on('message', receberDoApp); // child_process.fork com IPC (testes): a mesma mensagem
const scryptP = promisify(scrypt);
// O custo vai junto do hash ('scrypt$N$r$p$sal$hash'): dá para subir o custo um dia sem invalidar as senhas.
// N=2^15 usa 32 MiB por conferência, exatamente o maxmem padrão do Node: por isso o maxmem maior.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function gerarHash(senha) {
  const sal = randomBytes(16);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('hex')}$${(await scryptP(senha, sal, 32, SCRYPT)).toString('hex')}`;
}
const hashEmDia = (guardado) => guardado.startsWith(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`);
async function conferir(senha, guardado) {
  const partes = String(guardado).split('$');
  // formato antigo 'sal:hash': parâmetros padrão do scrypt do Node (N=2^14, r=8, p=1)
  const [N, r, p, sal, hash] = partes[0] === 'scrypt' && partes.length === 6
    ? [...partes.slice(1, 4).map(Number), partes[4], partes[5]] : [2 ** 14, 8, 1, ...String(guardado).split(':')];
  const esperado = Buffer.from(hash ?? '', 'hex');
  if (!sal || esperado.length !== 32) return false;
  return timingSafeEqual(await scryptP(senha, Buffer.from(sal, 'hex'), 32, { N, r, p, maxmem: SCRYPT.maxmem }), esperado);
}
// Nome que não existe confere contra este hash: a resposta demora o mesmo que uma senha errada
const HASH_FALSO = gerarHash(randomBytes(16).toString('hex'));

// Senhas novas (criar conta, trocar senha). Login continua aceitando as de 6–7 caracteres de antes.
const COMUNS = new Set(['12345678', '123456789', '1234567890', '87654321', '12341234', '11111111', '00000000', 'senha123',
  'senha1234', 'minhasenha', 'password', 'password1', 'qwerty123', 'qwertyuiop', 'abc12345', 'abcd1234', 'iloveyou', 'limb1234']);
function senhaNova(senha, nome) {
  if (senha.length < 8 || senha.length > 128) throw new HttpError(400, 'A senha precisa ter de 8 a 128 caracteres');
  const s = senha.toLowerCase();
  // nome de 2 letras ("ze") aparece dentro de muita palavra: a regra vale a partir de 3
  if (nome.length >= 3 && s.includes(nome)) throw new HttpError(400, 'A senha não pode conter o seu nome de usuário');
  if (COMUNS.has(s) || /^(.)\1+$/.test(s)) throw new HttpError(400, 'Essa senha é fácil demais de adivinhar. Escolha outra.');
  return senha;
}
function nomeDe(v) {
  const name = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_.]{2,32}$/.test(name)) throw new HttpError(400, 'Usuário: 2 a 32 caracteres (a-z, 0-9, _ e .)');
  return name;
}
// digests de tamanho fixo: timingSafeEqual exige o mesmo tamanho, e o tempo não entrega o código
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();
const conviteOk = (v) => timingSafeEqual(digest(String(v ?? '').trim()), digest(codigoConvite));
const CONVITE_VENCIDO = 'Este convite não vale mais. Peça um link novo para quem hospeda.';
const semContas = () => !q('SELECT 1 FROM users LIMIT 1').get();
// atrás de um proxy (Caddy/nginx com HTTPS), o IP real é o último do X-Forwarded-For: é o que o nosso proxy
// acrescentou (os anteriores vêm do cliente e podem ser inventados para fugir dos limites por IP).
// Proxy nesta mesma máquina (Tailscale Funnel, Caddy local) conecta pelo loopback: aí vale sem TRUST_PROXY.
// Sem isso, todo visitante do Funnel seria 127.0.0.1, e as senhas erradas de um bloqueariam todo mundo.
// Quem fala direto com o servidor pela rede não é loopback, então não consegue inventar o próprio IP.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function ipDe(req) {
  const socket = req.socket.remoteAddress;
  if (!process.env.TRUST_PROXY && !LOOPBACK.has(socket)) return socket;
  const ultimo = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim();
  return isIP(ultimo) ? ultimo : socket; // sem cabeçalho (o app de quem hospeda) ou com lixo: o do socket
}
// Sem contas, a primeira é do dono, mas só para quem está NESTE computador (o app de quem hospeda, um
// navegador em localhost). Funnel/Caddy também chegam pelo loopback, mas sempre com X-Forwarded-For: quem
// vem da internet nunca é o "dono" de um servidor vazio (o nome do Funnel sai nos registros públicos de
// certificados, e robôs visitam endereços novos em minutos).
const daMaquina = (req) => LOOPBACK.has(req.socket.remoteAddress)
  && !req.headers['x-forwarded-for'] && !req.headers.forwarded && !req.headers['x-forwarded-host'] && !req.headers['x-real-ip'];
const primeiraContaPara = (req) => semContas() && daMaquina(req);
// Servidor vazio visto de fora (quem hospeda testando o próprio link .ts.net no navegador): continua pedindo
// convite, mas diz onde criar a conta do dono em vez de mandar "pedir o link para quem hospeda"
const SERVIDOR_NOVO = 'Servidor novo: crie a primeira conta no app do Limb de quem hospeda, ou abra o link de convite (Servidor → Copiar convite).';

// ponytail: limites em memória; somem ao reiniciar o servidor
const esperaDe = (ms) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`);
const muitas = (msg, ms) => new HttpError(429, `${msg} Tente de novo em ${esperaDe(ms)}.`, { retry_after: Math.ceil(ms / 1000) });
const erros = new Map(); // ip → { n, desde }: 10 erros em 15 min (senha errada, convite errado)
function bloqueado(ip) {
  const e = erros.get(ip);
  if (e && Date.now() - e.desde > 15 * 60_000) erros.delete(ip);
  else if (e?.n >= 10) throw muitas('Muitas tentativas.', e.desde + 15 * 60_000 - Date.now());
}
const falhou = (ip) => { const e = erros.get(ip) ?? { n: 0, desde: Date.now() }; e.n++; erros.set(ip, e); };
// Por conta: do 5º erro seguido em diante, trava 1 min, depois 2, 4… até 15 min; acertar zera.
// ponytail: quem sabe o nome de alguém consegue travar a conta dele errando de propósito (DoS de bloqueio);
// o limite por IP segura isso para um atacante só, e em troca ninguém fica chutando a senha de uma conta.
const errosConta = new Map(); // nome → { n, ate, visto }
function contaLivre(nome) {
  const e = errosConta.get(nome);
  if (e?.ate > Date.now()) throw muitas('Muitas tentativas erradas nesta conta.', e.ate - Date.now());
}
function falhouConta(nome) {
  const e = errosConta.get(nome) ?? { n: 0, ate: 0 };
  e.n++; e.visto = Date.now();
  if (e.n >= 5) e.ate = Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** (e.n - 5));
  errosConta.set(nome, e);
}
// A tentativa conta como erro antes de conferir (o scrypt é assíncrono): pedidos em paralelo não furam o limite
function tentativa(ip, nome) { bloqueado(ip); contaLivre(nome); falhou(ip); falhouConta(nome); }
function acertou(ip, nome) { const e = erros.get(ip); if (e) e.n--; errosConta.delete(nome); }
const cadastros = new Map(); // ip → { n, desde }: 5 contas novas por hora
function cadastro(ip) {
  const c = cadastros.get(ip);
  if (c && Date.now() - c.desde > 60 * 60_000) cadastros.delete(ip);
  else if (c?.n >= 5) throw muitas('Muitas contas criadas a partir daqui.', c.desde + 60 * 60_000 - Date.now());
  const n = cadastros.get(ip) ?? { n: 0, desde: Date.now() }; n.n++; cadastros.set(ip, n);
  return () => n.n--; // desfaz, se a conta não chegou a ser criada
}

// ── Sessões de login ────────────────────────────────────────────────────────
// Um token por dispositivo; no banco fica só o sha256 dele (quem copiar o banco não entra como ninguém).
function hashToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }
function tokenAleatorio() { return randomBytes(32).toString('base64url'); }
// "Chrome · Windows", "App Limb · Android"…: só para a pessoa reconhecer o aparelho na lista
function dispositivo(ua = '') {
  const app = /Electron\//.test(ua) ? 'App Limb' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const so = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return so ? `${app} · ${so}` : app;
}
function criarSessao(userId, req) {
  const token = tokenAleatorio(), agora = Date.now();
  q('INSERT INTO sessions (id, user_id, token_hash, criado, usado, expira, dispositivo, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(snowflake(), userId, hashToken(token), agora, agora, agora + SESSAO_TTL, dispositivo(String(req.headers['user-agent'] ?? '')), ipDe(req) ?? null);
  revogar(q('SELECT id FROM sessions WHERE user_id = ? ORDER BY usado DESC, id DESC LIMIT -1 OFFSET ?').all(userId, MAX_SESSOES).map((s) => s.id));
  return token;
}
// token → { user, sessao } ou null. Expiração deslizante: cada uso empurra para mais 30 dias,
// gravando no máximo uma vez por hora por sessão (e não a cada pedido)
function autenticar(token) {
  if (!token || typeof token !== 'string') return null;
  const agora = Date.now();
  const r = q(`SELECT s.id AS sessao, s.usado, u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expira > ?`).get(hashToken(token), agora);
  if (!r) return null;
  if (agora - Number(r.usado) > 3_600_000) q('UPDATE sessions SET usado = ?, expira = ? WHERE id = ?').run(agora, agora + SESSAO_TTL, r.sessao);
  return { user: { id: r.id, username: r.name }, sessao: r.sessao };
}
// O token para de valer e os gateways abertos com ele caem na hora (4004), levando presença e voz junto
function revogar(ids) {
  if (!ids.length) return;
  for (const id of ids) q('DELETE FROM sessions WHERE id = ?').run(id);
  const fora = new Set(ids.map(String));
  for (const s of [...sessions.values()]) {
    if (!fora.has(String(s.auth))) continue;
    const ws = s.ws;
    s.ws = null; // o 'close' deste socket não deixa a sessão esperando um RESUME
    encerrar(s);
    ws?.close(4004, 'Authentication failed');
  }
}
const outrasSessoes = (user, req) => q('SELECT id FROM sessions WHERE user_id = ? AND id != ?').all(user.id, req.sessao).map((s) => s.id);
// Faxina: sessões vencidas saem do banco (gateway aberto conta como uso) e os limites velhos saem da memória
function faxina() {
  const agora = Date.now();
  for (const id of new Set([...sessions.values()].filter((s) => s.ws).map((s) => s.auth))) {
    q('UPDATE sessions SET usado = ?, expira = ? WHERE id = ?').run(agora, agora + SESSAO_TTL, id);
  }
  q('DELETE FROM sessions WHERE expira <= ?').run(agora);
  for (const [ip, e] of erros) if (agora - e.desde > 15 * 60_000) erros.delete(ip);
  for (const [ip, c] of cadastros) if (agora - c.desde > 60 * 60_000) cadastros.delete(ip);
  for (const [nome, e] of errosConta) if (e.ate <= agora && agora - e.visto > 60 * 60_000) errosConta.delete(nome);
}
faxina();
setInterval(faxina, 15 * 60_000).unref();

// STUN/TURN entregues ao cliente no READY da voz. Entre redes diferentes, STUN resolve a maioria
// dos casos; redes muito restritas precisam de um TURN (ex.: coturn) — ver README.
const STUN_GOOGLE = 'stun:stun.l.google.com:19302';
function lerIce() {
  try {
    if (process.env.ICE_SERVERS) {
      const lista = JSON.parse(process.env.ICE_SERVERS);
      if (Array.isArray(lista)) return lista;
      throw new Error('não é uma lista');
    }
  } catch { console.error('ICE_SERVERS inválido, usando o padrão'); }
  return [{ urls: STUN_GOOGLE }];
}
const ICE_FIXO = lerIce();

// TURN da Cloudflare (Realtime TURN): quem está no 4G ou atrás de CGNAT não fecha conexão direta só com STUN,
// e a mídia passa por lá. As credenciais duram TURN_TTL; a chave da API (token) nunca sai deste processo.
const CF = process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN ? {
  id: process.env.CF_TURN_KEY_ID, token: process.env.CF_TURN_API_TOKEN,
  api: (process.env.CF_TURN_API_URL || 'https://rtc.live.cloudflare.com/v1').replace(/\/+$/, ''), // CF_TURN_API_URL: só nos testes
} : null;
const TURN_TTL = 86_400; // s
const TURN_RENOVAR = 2 * 3_600_000; // renova quando faltam 2 h: chamada em andamento segue com a credencial antiga
const turn = { lista: null, vence: 0, buscando: null, espera: 60_000, proxima: 0, falhando: false, timer: null };

// Só o que o RTCPeerConnection aceita: uma entrada malformada faria o navegador recusar a lista inteira.
// Porta 53: Chrome e Firefox bloqueiam (porta "proibida") e a Cloudflare manda uma URL nela.
function iceValido(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.slice(0, 10).flatMap((s) => {
    const urls = [s?.urls].flat().filter((u) => typeof u === 'string' && /^(stuns?|turns?):\S{1,250}$/.test(u) && !/:53(\?|$)/.test(u));
    if (!urls.length) return [];
    if (typeof s.username === 'string' && typeof s.credential === 'string') return [{ urls, username: s.username, credential: s.credential }];
    return urls.some((u) => u.startsWith('turn')) ? [] : [{ urls }]; // TURN sem credencial não serve
  });
}
const temStun = (lista) => lista.some((s) => [s.urls].flat().some((u) => /^stuns?:/.test(u)));

function agendarTurn(ms) {
  clearTimeout(turn.timer);
  turn.timer = setTimeout(buscarTurn, ms).unref();
}
// Uma busca por vez; falhou: avisa uma vez só (sem o token), segue com a lista fixa e tenta de novo
// em 1 min, 2, 4… até 30 min
function buscarTurn() {
  turn.buscando ??= pedirTurn().finally(() => { turn.buscando = null; });
  return turn.buscando;
}
async function pedirTurn() {
  try {
    const r = await fetch(`${CF.api}/turn/keys/${encodeURIComponent(CF.id)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) r.body?.cancel().catch(() => {}); // libera a conexão
    if (!r.ok) throw new Error(`HTTP ${r.status}${[401, 403, 404].includes(r.status) ? ': confira o ID e o token da chave TURN' : ''}`);
    const lista = iceValido((await r.json())?.iceServers);
    if (!lista.length) throw new Error('resposta sem iceServers');
    Object.assign(turn, { lista, vence: Date.now() + TURN_TTL * 1000, espera: 60_000, proxima: 0 });
    if (turn.falhando) console.log('TURN da Cloudflare funcionando de novo');
    turn.falhando = false;
    agendarTurn(TURN_TTL * 1000 - TURN_RENOVAR);
  } catch (e) {
    const motivo = e.name === 'TimeoutError' ? 'sem resposta em 10 s' : `${e.message}${e.cause?.code ? ` ${e.cause.code}` : ''}`;
    if (!turn.falhando) console.error(`TURN da Cloudflare indisponível (${motivo}); a voz segue só com STUN e o Limb tenta de novo sozinho.`);
    turn.falhando = true;
    turn.proxima = Date.now() + turn.espera;
    agendarTurn(turn.espera);
    turn.espera = Math.min(turn.espera * 2, 30 * 60_000);
  }
}

// Lista do READY da voz: credenciais da Cloudflare + a lista fixa (sem o STUN do Google, se a Cloudflare já
// manda um). Sem credencial válida e com uma busca em andamento (logo depois de subir), espera até 2 s por ela.
function iceAtual() {
  if (!CF) return ICE_FIXO;
  const montar = () => {
    if (!turn.lista || turn.vence <= Date.now()) return ICE_FIXO;
    const fixos = temStun(turn.lista) ? ICE_FIXO.filter((s) => [s?.urls].flat().join() !== STUN_GOOGLE) : ICE_FIXO;
    return [...turn.lista, ...fixos];
  };
  // o timer pode atrasar (PC que hibernou): renova aqui também, sem esperar
  const restante = turn.vence - Date.now();
  if (!turn.buscando && restante < TURN_RENOVAR && Date.now() >= turn.proxima) buscarTurn();
  if (restante > 0 || !turn.buscando) return montar();
  let timer;
  const limite = new Promise((r) => { timer = setTimeout(r, 2000); });
  return Promise.race([turn.buscando, limite]).then(() => { clearTimeout(timer); return montar(); });
}
if (CF) buscarTurn(); // em segundo plano: o primeiro READY já costuma encontrar as credenciais

const rotas = [
  // O que a tela de login (e o "Testar" do app desktop) precisa saber antes de entrar
  // primeiraConta: servidor sem ninguém ainda, visto deste computador. A primeira conta (a do dono) não precisa
  // de convite; quem vem de fora (Funnel, proxy, rede) encontra o servidor vazio pedindo convite como sempre.
  // semDono: esse mesmo servidor vazio, visto de fora. Não libera nada, só muda o aviso da tela.
  ['GET', /^\/api\/info$/, (req) => {
    const primeira = primeiraContaPara(req);
    const convite = !!codigoConvite && !primeira;
    return { convite, primeiraConta: primeira, semDono: convite && semContas(), nome: NOME_SERVIDOR, versao: VERSAO };
  }, { publica: true }],

  // Entrar numa conta que já existe; cada login é uma sessão nova (um token por dispositivo).
  // Nome desconhecido e senha errada dão a mesma resposta, no mesmo tempo: não dá para descobrir quem tem conta.
  ['POST', /^\/api\/login$/, async (req) => {
    const ip = ipDe(req);
    const name = nomeDe(req.body.username);
    const senha = String(req.body.password ?? '');
    if (!senha || senha.length > 128) throw new HttpError(400, 'Digite a senha (até 128 caracteres)');
    tentativa(ip, name);
    const u = q('SELECT * FROM users WHERE name = ?').get(name);
    if (u && u.senha == null) {
      // Conta de antes das senhas: o primeiro login define a senha. Com convite no servidor, só quem tem o código
      // reivindica a conta. Sem convite, qualquer um que alcança o servidor já cria conta: exigir mais só
      // trancaria o dono de fora.
      if (codigoConvite && !conviteOk(req.body.invite)) {
        throw new HttpError(403, req.body.invite ? CONVITE_VENCIDO
          : 'Esta conta é de antes das senhas. Para criar a senha dela, cole também o link de convite do servidor.', { convite: true });
      }
      const hash = await gerarHash(senhaNova(senha, name)); // senha fraca (400) não zera os contadores de erro
      acertou(ip, name);
      q('UPDATE users SET senha = ? WHERE id = ?').run(hash, u.id);
    } else {
      const guardado = u?.senha ?? (await HASH_FALSO);
      const ok = await conferir(senha, guardado);
      // hash antigo (N=2^14) custa metade: mais um scrypt igual, para o tempo não entregar quais contas existem
      if (!hashEmDia(guardado)) await scryptP(senha, randomBytes(16), 32, { N: 2 ** 14, r: 8, p: 1 });
      if (!u || !ok) throw new HttpError(401, 'Usuário ou senha incorretos');
      acertou(ip, name);
      if (!hashEmDia(u.senha)) q('UPDATE users SET senha = ? WHERE id = ?').run(await gerarHash(senha), u.id); // formato antigo: refaz
    }
    return { token: criarSessao(u.id, req), user: { id: u.id, username: u.name } };
  }, { publica: true }],

  // Criar conta (com o código do link de convite, se o servidor exigir). Já entra: devolve o token da primeira sessão.
  ['POST', /^\/api\/register$/, async (req) => {
    const ip = ipDe(req);
    bloqueado(ip);
    const name = nomeDe(req.body.username);
    // A primeira conta do servidor é a do dono: entra sem convite se pedida deste computador (quem hospeda não
    // precisa de link para si mesmo; quem chega pela internet precisa)
    const convidado = !codigoConvite || conviteOk(req.body.invite);
    const semConvite = () => new HttpError(403, req.body.invite ? CONVITE_VENCIDO
      : semContas() ? SERVIDOR_NOVO : 'Este servidor só aceita convidados. Peça o link de convite para quem hospeda.', { convite: true });
    if (!convidado && !primeiraContaPara(req)) { falhou(ip); throw semConvite(); }
    const senha = senhaNova(String(req.body.password ?? ''), name);
    const emUso = () => q('SELECT 1 FROM users WHERE name = ?').get(name);
    // antes do scrypt: nome ocupado não gasta CPU, e conta como erro (senão dá para repetir sem limite)
    if (emUso()) { falhou(ip); throw new HttpError(409, 'Esse nome de usuário já está em uso'); }
    const desfazer = cadastro(ip);
    const hash = await gerarHash(senha);
    // confere de novo depois do await: dois cadastros com o mesmo nome ao mesmo tempo não passam os dois
    if (emUso()) { desfazer(); falhou(ip); throw new HttpError(409, 'Esse nome de usuário já está em uso'); }
    // dois "primeiros" ao mesmo tempo: só um passa sem convite
    if (!convidado && !primeiraContaPara(req)) { desfazer(); falhou(ip); throw semConvite(); }
    const u = { id: snowflake(), username: name };
    // users.token é NOT NULL UNIQUE desde a primeira versão: ganha um valor aleatório que nunca é usado
    q('INSERT INTO users (id, name, token, senha) VALUES (?, ?, ?, ?)').run(u.id, name, tokenAleatorio(), hash);
    broadcast('USER_CREATE', u);
    return { token: criarSessao(u.id, req), user: u };
  }, { publica: true }],

  // Sair: derruba só este dispositivo (os gateways abertos com o token fecham com 4004)
  ['POST', /^\/api\/logout$/, (req) => { revogar([req.sessao]); return null; }],

  // Trocar a senha: confere a atual e, como no Discord, desconecta os outros dispositivos (este continua)
  ['POST', /^\/api\/users\/@me\/password$/, async (req, user) => {
    const ip = ipDe(req);
    const nova = senhaNova(String(req.body.senha_nova ?? ''), user.username);
    const { senha } = q('SELECT senha FROM users WHERE id = ?').get(user.id);
    if (senha != null) { // conta de antes das senhas que entrou pelo token antigo: não tem senha atual para conferir
      tentativa(ip, user.username);
      if (!(await conferir(String(req.body.senha_atual ?? ''), senha))) throw new HttpError(403, 'A senha atual está incorreta');
      acertou(ip, user.username);
    }
    q('UPDATE users SET senha = ? WHERE id = ?').run(await gerarHash(nova), user.id);
    revogar(outrasSessoes(user, req));
    return null;
  }],

  // Dispositivos conectados: só as sessões da própria conta, nunca o hash do token
  ['GET', /^\/api\/users\/@me\/sessions$/, (req, user) => q('SELECT id, dispositivo, criado, usado FROM sessions WHERE user_id = ? AND expira > ? ORDER BY usado DESC')
    .all(user.id, Date.now()).map((s) => ({ id: s.id, dispositivo: s.dispositivo, criado: Number(s.criado), usado: Number(s.usado), atual: s.id === req.sessao }))],
  ['DELETE', /^\/api\/users\/@me\/sessions\/(\d+)$/, (req, user, [sid]) => {
    const s = q('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(id64(sid), user.id);
    if (!s) throw new HttpError(404, 'Sessão não encontrada');
    revogar([s.id]);
    return null;
  }],
  ['POST', /^\/api\/users\/@me\/sessions\/encerrar-outras$/, (req, user) => { revogar(outrasSessoes(user, req)); return null; }],

  ['POST', /^\/api\/guilds$/, (req, user) => {
    const name = String(req.body.name ?? '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, 'Nome obrigatório');
    const g = criarGuild(name, user.id);
    broadcast('GUILD_CREATE', g);
    return g;
  }],

  ['POST', /^\/api\/guilds\/(\d+)\/channels$/, (req, user, [gid]) => {
    const g = q('SELECT * FROM guilds WHERE id = ?').get(id64(gid));
    if (!g) throw new HttpError(404, 'Servidor não encontrado');
    const type = req.body.type === CANAL.VOZ ? CANAL.VOZ : CANAL.TEXTO;
    // texto: minúsculas com hífens; voz aceita espaços e maiúsculas (igual ao Discord)
    const name = type === CANAL.VOZ ? String(req.body.name ?? '').trim().slice(0, 100) : nomeCanal(req.body.name);
    if (!name) throw new HttpError(400, 'Nome obrigatório');
    const c = criarCanal(g.id, name, type);
    broadcast('CHANNEL_CREATE', c);
    return c;
  }],

  // Histórico paginado por cursor de snowflake (?before=<id>&limit=50), como a API real
  ['GET', /^\/api\/channels\/(\d+)\/messages$/, (req, user, [cid]) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.get('limit')) || 50));
    const before = req.query.get('before') ? id64(req.query.get('before')) : 2n ** 63n - 1n;
    return comReacoes(q(`${MSG_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
      .all(canal(cid).id, before, limit).map(messagePayload), user.id);
  }],

  // nonce volta no MESSAGE_CREATE: o cliente troca a mensagem otimista pela real
  ['POST', /^\/api\/channels\/(\d+)\/messages$/, (req, user, [cid]) => {
    const c = canal(cid);
    const content = conteudo(req.body.content);
    const ref = req.body.message_reference?.message_id;
    const replyTo = ref == null ? null : mensagemDoCanal(cid, String(ref)).id; // resposta só no mesmo canal
    const ids = mencoes(content);
    const id = snowflake();
    q('INSERT INTO messages (id, channel_id, author_id, content, reply_to, mentions) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, c.id, user.id, content, replyTo, JSON.stringify(ids));
    // quem foi mencionado ganha +1 no contador do canal (zera no ack)
    for (const uid of ids) {
      if (BigInt(uid) === user.id) continue;
      q(`INSERT INTO read_states (user_id, channel_id, mention_count) VALUES (?, ?, 1)
         ON CONFLICT DO UPDATE SET mention_count = mention_count + 1`).run(BigInt(uid), c.id);
    }
    // a própria mensagem do autor já conta como lida
    q(`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, ?)
       ON CONFLICT DO UPDATE SET last_message_id = max(last_message_id, excluded.last_message_id)`).run(user.id, c.id, id);
    const msg = { ...getMessage(id), nonce: String(req.body.nonce ?? '').slice(0, 25) || undefined };
    broadcast('MESSAGE_CREATE', msg);
    return msg;
  }],

  ['PATCH', /^\/api\/channels\/(\d+)\/messages\/(\d+)$/, (req, user, [cid, mid]) => {
    const m = minhaMensagem(cid, mid, user);
    const content = conteudo(req.body.content);
    // editar não notifica de novo (contador não sobe), igual ao Discord
    q('UPDATE messages SET content = ?, mentions = ?, edited_timestamp = ? WHERE id = ?')
      .run(content, JSON.stringify(mencoes(content)), new Date().toISOString(), m.id);
    const msg = getMessage(m.id);
    broadcast('MESSAGE_UPDATE', msg);
    return msg;
  }],

  ['DELETE', /^\/api\/channels\/(\d+)\/messages\/(\d+)$/, (req, user, [cid, mid]) => {
    const m = minhaMensagem(cid, mid, user);
    q('DELETE FROM reactions WHERE message_id = ?').run(m.id);
    q('DELETE FROM messages WHERE id = ?').run(m.id);
    broadcast('MESSAGE_DELETE', { id: m.id, channel_id: m.channel_id });
    return null;
  }],

  // PUT/DELETE /channels/:c/messages/:m/reactions/:emoji/@me — mesma rota do Discord
  ['PUT', /^\/api\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/, (req, user, [cid, mid, raw]) => {
    const m = mensagemDoCanal(cid, mid);
    const e = emoji(raw);
    const existe = q('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?').get(m.id, e);
    if (!existe && q('SELECT count(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?').get(m.id).n >= MAX_REACOES) {
      throw new HttpError(400, `Máximo de ${MAX_REACOES} reações diferentes`);
    }
    if (q('INSERT OR IGNORE INTO reactions VALUES (?, ?, ?)').run(m.id, user.id, e).changes) {
      broadcast('MESSAGE_REACTION_ADD', { message_id: m.id, channel_id: m.channel_id, user_id: user.id, emoji: e });
    }
    return null;
  }],
  ['DELETE', /^\/api\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/, (req, user, [cid, mid, raw]) => {
    const m = mensagemDoCanal(cid, mid);
    const e = emoji(raw);
    if (q('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, user.id, e).changes) {
      broadcast('MESSAGE_REACTION_REMOVE', { message_id: m.id, channel_id: m.channel_id, user_id: user.id, emoji: e });
    }
    return null;
  }],

  // Marca como lido até :mid e zera menções; avisa as outras abas do mesmo usuário (MESSAGE_ACK)
  ['POST', /^\/api\/channels\/(\d+)\/messages\/(\d+)\/ack$/, (req, user, [cid, mid]) => {
    const c = canal(cid);
    q(`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, ?)
       ON CONFLICT DO UPDATE SET last_message_id = max(last_message_id, excluded.last_message_id), mention_count = 0`)
      .run(user.id, c.id, id64(mid));
    paraUsuario(user.id, 'MESSAGE_ACK', { channel_id: c.id, message_id: mid });
    return null;
  }],

  // Cliente chama a cada ~8s enquanto digita; o indicador expira sozinho em 10s
  ['POST', /^\/api\/channels\/(\d+)\/typing$/, (req, user, [cid]) => {
    broadcast('TYPING_START', { channel_id: String(id64(cid)), user_id: user.id, timestamp: Date.now() });
    return null;
  }],

  // GET /api/guilds/:id/messages/search?q=from:ana has:link before:2026-10-01 oi&offset=0&sort_order=asc
  // Diferença: o Discord monta os parâmetros no cliente; aqui o servidor lê a frase (uma implementação só).
  ['GET', /^\/api\/guilds\/(\d+)\/messages\/search$/, (req, user, [gid]) => {
    const { sql, params } = searchToSql(parseSearch(req.query.get('q')));
    const where = `c.guild_id = ? AND ${sql}`;
    const offset = Math.min(5000, Math.max(0, Number(req.query.get('offset')) || 0));
    const ordem = req.query.get('sort_order') === 'asc' ? 'ASC' : 'DESC';
    const total = q(`SELECT count(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE ${where}`).get(id64(gid), ...params).n;
    const messages = q(`${MSG_SELECT} WHERE ${where} ORDER BY m.id ${ordem} LIMIT 25 OFFSET ?`)
      .all(id64(gid), ...params, offset).map(messagePayload);
    return { total_results: Number(total), messages };
  }],
];

// Junta os bytes e decodifica uma vez só: somando pedaço a pedaço, um acento ou emoji cortado entre dois pedaços
// (o Funnel entrega em vários) virava "��" na mensagem de todo mundo
async function lerCorpo(req) {
  const partes = [];
  let n = 0;
  for await (const chunk of req) { n += chunk.length; if (n > 64_000) throw new HttpError(413, 'Corpo grande demais'); partes.push(chunk); }
  const s = Buffer.concat(partes).toString('utf8');
  try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, 'JSON inválido'); }
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
// Com o servidor na internet (Funnel), outro site não pode pôr o Limb num iframe e enganar o clique (clickjacking).
// frame-ancestors só vale em cabeçalho (na <meta> é ignorado); X-Frame-Options cobre navegador antigo.
const SEM_MOLDURA = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
async function estatico(url, res) {
  const pedido = url.pathname === '/' ? '/index.html' : url.pathname;
  // Só nomes simples em minúsculas: no Windows, "CONVITE.HTML", "convite.html." e "CONVIT~1.HTM" abrem o mesmo
  // arquivo, e o modelo da página de convite só pode sair preenchido, por /convite/<código>
  if (!/^(\/[a-z0-9_-]+)*\/[a-z0-9_-]+(\.[a-z0-9]+)+$/.test(pedido) || pedido === '/convite.html') return res.writeHead(404).end('Não encontrado');
  const arquivo = path.resolve(PUBLIC, '.' + pedido);
  if (!arquivo.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
  let corpo;
  try { corpo = await readFile(arquivo); } catch { return res.writeHead(404).end('Não encontrado'); }
  // no-cache + ETag: o navegador sempre confere, mas só baixa de novo se o arquivo mudou (atualização chega na hora)
  const etag = `"${createHash('sha1').update(corpo).digest('base64url')}"`;
  const html = path.extname(arquivo) === '.html';
  const cab = { ETag: etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...(html && SEM_MOLDURA) };
  if (res.req.headers['if-none-match'] === etag) return res.writeHead(304, cab).end();
  res.writeHead(200, { ...cab, 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream' }).end(corpo);
}

// ── Página de convite ───────────────────────────────────────────────────────
// /convite/<código>: o link que o anfitrião manda no WhatsApp. Montada aqui (e não pelo JS) porque quem gera a
// prévia do link (og:title…) não roda script. Como no Discord, o link É o convite: com o código errado (link
// antigo, depois do "Gerar link novo") a página diz que ele não vale mais, sem botões. Cada código errado conta
// como erro no limite por IP, igual ao cadastro: senão a página viraria um jeito de chutar códigos. Bloqueado,
// todo convite aparece como "não vale" (não dá para saber se acertou).
const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DOWNLOAD = VERSAO ? `https://github.com/AllanDeOliveira/Limb/releases/download/v${VERSAO}/Limb-${VERSAO}-instalador.exe`
  : 'https://github.com/AllanDeOliveira/Limb/releases/latest';
function conviteValePara(ip, codigo) {
  if (!codigoConvite) return true; // servidor aberto: qualquer link serve
  try { bloqueado(ip); } catch { return false; }
  if (!codigo) return false; // /convite sem código não chuta nada: não conta como erro
  if (conviteOk(codigo)) return true;
  falhou(ip);
  return false;
}
async function paginaConvite(bruto, req, res) {
  let codigo = '';
  try { codigo = decodeURIComponent(bruto ?? '').trim(); } catch { /* %E0%A4 cortado no meio: página sem código */ }
  if (codigo.length > 100) codigo = '';
  const valido = conviteValePara(ipDe(req), codigo);
  const valores = {
    nome: NOME_SERVIDOR, codigo, download: DOWNLOAD,
    entrar: codigo ? `/#convite=${encodeURIComponent(codigo)}` : '/',
    titulo: valido ? `Convite para ${NOME_SERVIDOR} no Limb` : 'Convite do Limb',
    descricao: valido ? `Você foi convidado para ${NOME_SERVIDOR}. Conversa de texto e voz, com compartilhamento de tela.`
      : 'Conversa de texto e voz, com compartilhamento de tela.',
  };
  let modelo;
  try { modelo = await readFile(path.join(PUBLIC, 'convite.html'), 'utf8'); } catch { return res.writeHead(404).end('Não encontrado'); }
  // Trechos <!--valido-->…<!--/valido--> e <!--invalido-->…<!--/invalido-->: só um dos dois sai na página.
  // Antes da troca dos {{…}}: o nome e o código não conseguem abrir nem fechar um trecho.
  const parte = valido ? 'valido' : 'invalido';
  const corpo = modelo.replace(/<!--(valido|invalido)-->([\s\S]*?)<!--\/\1-->/g, (_, k, dentro) => (k === parte ? dentro : ''))
    // uma passada só: um {{…}} dentro do nome ou do código não é trocado de novo
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in valores ? escapar(valores[k]) : m));
  res.writeHead(valido ? 200 : 404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', // o código está no endereço: não vai para o GitHub ao baixar
    ...SEM_MOLDURA,
  }).end(corpo);
}

// Nenhuma falha de um pedido pode derrubar o servidor de todos (a rejeição de um handler async mata o processo)
const falhaPedido = (res) => (e) => { console.error(e); if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); };
const server = http.createServer(async (req, res) => {
  let url;
  // "GET //" ou "//:99999": new URL lança exceção, e sem isto o servidor caía
  try { url = new URL(req.url, 'http://localhost'); } catch { return res.writeHead(400).end(); }
  const convite = /^\/convite(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (convite && ['GET', 'HEAD'].includes(req.method)) return paginaConvite(convite[1], req, res).catch(falhaPedido(res));
  if (!url.pathname.startsWith('/api/')) return estatico(url, res).catch(falhaPedido(res));
  try {
    const rota = rotas.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!rota) throw new HttpError(404, 'Rota não encontrada');
    const [, re, fn, opts] = rota;
    const auth = opts?.publica ? null : autenticar(req.headers.authorization);
    if (!auth && !opts?.publica) throw new HttpError(401, 'Não autorizado');
    req.sessao = auth?.sessao; // sessão de login deste pedido (sair, trocar senha, dispositivos)
    req.body = ['POST', 'PATCH'].includes(req.method) ? await lerCorpo(req) : {};
    req.query = url.searchParams;
    const out = await fn(req, auth?.user, url.pathname.match(re).slice(1));
    // no-store: respostas da API (algumas com token) não ficam em cache nenhum
    if (out === null) return res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(json(out));
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(json({ message: e.status ? e.message : 'Erro interno', ...e.extra }));
  }
});

// Dois gateways no mesmo servidor HTTP (principal e voz): roteia o upgrade pelo caminho
const wsPrincipal = new WebSocketServer({ noServer: true, maxPayload: 4096 }).on('connection', gateway);
const wsVoz = new WebSocketServer({ noServer: true, maxPayload: 65_536 }).on('connection', voz.gatewayVoz); // SDP é maior
server.on('upgrade', (req, socket, head) => {
  let caminho;
  try { caminho = new URL(req.url, 'http://x').pathname; } catch { return socket.destroy(); }
  const alvo = { '/gateway': wsPrincipal, '/voice': wsVoz }[caminho];
  if (!alvo) return socket.destroy();
  alvo.handleUpgrade(req, socket, head, (ws) => alvo.emit('connection', ws, req));
});
// Última rede de proteção: com o servidor na internet, um erro que escape (bug ainda não visto) fica no log
// em vez de derrubar a conversa de todos
process.on('uncaughtException', (e) => console.error('[erro não tratado]', e));
process.on('unhandledRejection', (e) => console.error('[promessa rejeitada]', e));
// HOST=127.0.0.1 deixa só esta máquina entrar (padrão do app desktop); sem HOST, aceita a rede local
server.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`Limb em http://localhost:${server.address().port}`);
  process.parentPort?.postMessage({ pronto: server.address().port }); // avisa o app desktop (utilityProcess)
});
