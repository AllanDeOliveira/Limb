// Servidor estilo Discord: REST (/api) para escrever, Gateway (WebSocket /gateway)
// para receber eventos em tempo real. Mesmo fluxo observado no cliente oficial:
// HELLO(10) → IDENTIFY(2) → DISPATCH(0) READY; HEARTBEAT(1) ↔ HEARTBEAT_ACK(11);
// reconexão: RESUME(6) {token, session_id, seq} → eventos perdidos + RESUMED, ou INVALID_SESSION(9).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { snowflake, parseSearch, searchToSql } from './lib.js';
import { pack, unpack } from './public/etf.js';
import { criarVoz } from './voice.js';

const PORT = Number(process.env.PORT ?? 3000); // PORT=0 = porta livre qualquer (testes)
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url)); // relativo ao arquivo: funciona dentro do app empacotado
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, VOICE_STATE_UPDATE: 4, RESUME: 6, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
const CANAL = { TEXTO: 0, VOZ: 2 }; // GUILD_TEXT=0, GUILD_VOICE=2 no bundle do Discord
const HEARTBEAT_INTERVAL = 41250; // valor que o gateway real anuncia no HELLO
const RESUME_WINDOW = Number(process.env.RESUME_WINDOW_MS) || 45_000; // sessão sem socket espera isso por um RESUME
const REPLAY_MAX = 1000; // eventos guardados por sessão para reenviar no RESUME
const MAX_REACOES = 20; // emojis distintos por mensagem (limite do Discord)

// ── Banco ───────────────────────────────────────────────────────────────────
// ids são snowflakes (INTEGER 64 bits) → readBigInts, e viram string no JSON, como na API do Discord
const db = new DatabaseSync(process.env.DB_FILE || 'limb.db', { readBigInts: true });
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
`);
// Bancos criados pela versão anterior não têm estas colunas
const colunas = db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((c) => c.name);
if (!colunas.includes('reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
if (!colunas.includes('mentions')) db.exec("ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'");
// senha: 'sal:hash' (scrypt). null = conta antiga, do tempo em que só o nome bastava
if (!db.prepare("SELECT name FROM pragma_table_info('users')").all().some((c) => c.name === 'senha')) db.exec('ALTER TABLE users ADD COLUMN senha TEXT');

const q = (sql) => db.prepare(sql);
if (!q("SELECT name FROM pragma_table_info('channels')").all().some((c) => c.name === 'type')) {
  db.exec('ALTER TABLE channels ADD COLUMN type INTEGER NOT NULL DEFAULT 0');
  // servidores que já existiam ganham um canal de voz, como os novos
  for (const g of q('SELECT id FROM guilds').all()) criarCanal(g.id, 'Geral', CANAL.VOZ);
}
if (!q('SELECT 1 FROM guilds').get()) criarGuild('Servidor REA', null);

function criarGuild(name, ownerId) {
  const id = snowflake();
  q('INSERT INTO guilds VALUES (?, ?, ?)').run(id, name, ownerId);
  criarCanal(id, 'geral', CANAL.TEXTO);
  criarCanal(id, 'Geral', CANAL.VOZ);
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
const sessions = new Map(); // session_id → { id, user, seq, ws, buffer, expira }
const online = () => [...new Set([...sessions.values()].map((s) => s.user.id))];

// Cada socket escolhe o formato na URL (?encoding=json|etf), como no gateway do Discord.
// ETF: BigInt (snowflake) vai como SMALL_BIG; campos undefined somem, igual ao JSON.
const semUndefined = (v) => (Array.isArray(v) ? v.map(semUndefined)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, semUndefined(x)]))
  : v);
function send(s, payload) {
  if (s.ws?.readyState !== 1) return;
  s.ws.send(s.ws.etf ? pack(semUndefined(payload)) : json(payload));
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
  iceServers: lerIce(),
  paraSessao: dispatch,
  canalDeVoz: (id) => /^\d{1,20}$/.test(id) && q('SELECT * FROM channels WHERE id = ? AND type = ?').get(BigInt(id), CANAL.VOZ),
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

function gateway(ws, req) {
  ws.etf = new URL(req.url, 'http://x').searchParams.get('encoding') === 'etf';
  let s = null, timer;
  // Cliente que não manda heartbeat no prazo é zumbi: fecha (código 4009 = session timed out)
  const vigiar = () => { clearTimeout(timer); timer = setTimeout(() => ws.close(4009, 'Session timed out'), HEARTBEAT_INTERVAL * 1.5); };
  vigiar();
  send({ ws }, { op: OP.HELLO, d: { heartbeat_interval: HEARTBEAT_INTERVAL } });

  ws.on('message', (raw) => {
    let p;
    try { p = ws.etf ? unpack(raw) : JSON.parse(raw); } catch { return ws.close(4002, 'Decode error'); }
    if (p.op === OP.HEARTBEAT) { vigiar(); return send({ ws }, { op: OP.HEARTBEAT_ACK }); }
    if (s) {
      if (p.op === OP.VOICE_STATE_UPDATE) {
        const erro = voz.atualizarEstado(s, p.d);
        if (erro) dispatch(s, 'VOICE_STATE_ERROR', { message: erro }); // ponytail: o Discord só ignora
      }
      return;
    }

    if (p.op === OP.IDENTIFY) {
      const user = userByToken(p.d?.token);
      if (!user) return ws.close(4004, 'Authentication failed');
      const jaOnline = online().includes(user.id);
      s = { id: randomBytes(16).toString('hex'), user, seq: 0, ws, buffer: [], expira: null };
      sessions.set(s.id, s);
      dispatch(s, 'READY', readyPayload(s));
      if (!jaOnline) presence(user, 'online');
      return;
    }

    if (p.op === OP.RESUME) {
      const old = sessions.get(String(p.d?.session_id));
      const user = userByToken(p.d?.token);
      const seq = Number(p.d?.seq);
      const perdidos = old?.buffer.filter((e) => e.s > seq) ?? [];
      // Só retoma se é o dono, a sessão está sem socket e o buffer cobre tudo depois de `seq`
      const cobre = old && seq <= old.seq && (perdidos.length ? perdidos[0].s === seq + 1 : seq === old.seq);
      if (!old || !user || user.id !== old.user.id || old.ws || !cobre) {
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
  });

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
function userByToken(token) {
  const u = token && q('SELECT id, name FROM users WHERE token = ?').get(String(token));
  return u && { id: u.id, username: u.name };
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const id64 = (v) => { if (!/^\d{1,20}$/.test(v ?? '')) throw new HttpError(400, 'id inválido'); return BigInt(v); };
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
const CONVITE = process.env.INVITE_CODE || ''; // vazio = qualquer um que alcance o servidor cria conta
const scryptP = promisify(scrypt);
const gerarHash = async (senha) => { const sal = randomBytes(16); return `${sal.toString('hex')}:${(await scryptP(senha, sal, 32)).toString('hex')}`; };
async function conferir(senha, guardado) {
  const [sal, hash] = guardado.split(':');
  return timingSafeEqual(await scryptP(senha, Buffer.from(sal, 'hex'), 32), Buffer.from(hash, 'hex'));
}
// ponytail: limite por IP em memória (10 erros / 15 min); some ao reiniciar o servidor
const erros = new Map();
function bloqueado(ip) {
  const e = erros.get(ip);
  if (e && Date.now() - e.desde > 15 * 60_000) erros.delete(ip);
  else if (e?.n >= 10) throw new HttpError(429, 'Muitas tentativas. Espere 15 minutos.');
}
const falhou = (ip) => { const e = erros.get(ip) ?? { n: 0, desde: Date.now() }; e.n++; erros.set(ip, e); };

// STUN/TURN entregues ao cliente no READY da voz. Entre redes diferentes, STUN resolve a maioria
// dos casos; redes muito restritas precisam de um TURN (ex.: coturn) — ver README.
function lerIce() {
  try { if (process.env.ICE_SERVERS) return JSON.parse(process.env.ICE_SERVERS); } catch { console.error('ICE_SERVERS inválido, usando o padrão'); }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

const rotas = [
  // O que a tela de login precisa saber antes de entrar
  ['GET', /^\/api\/info$/, () => ({ convite: !!CONVITE }), { publica: true }],

  // Entrar ou criar conta. Nome novo cria a conta (com código de convite, se o servidor exigir).
  ['POST', /^\/api\/login$/, async (req) => {
    // atrás de um proxy (Caddy/nginx com HTTPS), o IP real vem no X-Forwarded-For
    const ip = (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress;
    bloqueado(ip);
    const name = String(req.body.username ?? '').trim().toLowerCase();
    const senha = String(req.body.password ?? '');
    if (!/^[a-z0-9_.]{2,32}$/.test(name)) throw new HttpError(400, 'Usuário: 2 a 32 caracteres (a-z, 0-9, _ e .)');
    if (senha.length < 6 || senha.length > 128) throw new HttpError(400, 'Senha: 6 a 128 caracteres');
    let u = q('SELECT * FROM users WHERE name = ?').get(name);
    if (!u) {
      if (CONVITE && String(req.body.invite ?? '') !== CONVITE) { falhou(ip); throw new HttpError(403, 'Código de convite inválido'); }
      u = { id: snowflake(), name, token: randomBytes(24).toString('base64url') };
      q('INSERT INTO users (id, name, token, senha) VALUES (?, ?, ?, ?)').run(u.id, u.name, u.token, await gerarHash(senha));
      broadcast('USER_CREATE', { id: u.id, username: u.name });
    } else if (u.senha == null) {
      // conta de antes das senhas: o primeiro login define a senha
      q('UPDATE users SET senha = ? WHERE id = ?').run(await gerarHash(senha), u.id);
    } else if (!(await conferir(senha, u.senha))) {
      falhou(ip);
      throw new HttpError(401, 'Usuário ou senha incorretos');
    }
    return { token: u.token, user: { id: u.id, username: u.name } };
  }, { publica: true }],

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

async function lerCorpo(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 64_000) throw new HttpError(413, 'Corpo grande demais'); }
  try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, 'JSON inválido'); }
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
async function estatico(url, res) {
  const arquivo = path.resolve(PUBLIC, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!arquivo.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
  let corpo;
  try { corpo = await readFile(arquivo); } catch { return res.writeHead(404).end('Não encontrado'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream' }).end(corpo);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return estatico(url, res);
  try {
    const rota = rotas.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!rota) throw new HttpError(404, 'Rota não encontrada');
    const [, re, fn, opts] = rota;
    const user = userByToken(req.headers.authorization);
    if (!user && !opts?.publica) throw new HttpError(401, 'Não autorizado');
    req.body = ['POST', 'PATCH'].includes(req.method) ? await lerCorpo(req) : {};
    req.query = url.searchParams;
    const out = await fn(req, user, url.pathname.match(re).slice(1));
    if (out === null) return res.writeHead(204).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(json(out));
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' })
      .end(json({ message: e.status ? e.message : 'Erro interno' }));
  }
});

// Dois gateways no mesmo servidor HTTP (principal e voz): roteia o upgrade pelo caminho
const wsPrincipal = new WebSocketServer({ noServer: true, maxPayload: 4096 }).on('connection', gateway);
const wsVoz = new WebSocketServer({ noServer: true, maxPayload: 65_536 }).on('connection', voz.gatewayVoz); // SDP é maior
server.on('upgrade', (req, socket, head) => {
  const alvo = { '/gateway': wsPrincipal, '/voice': wsVoz }[new URL(req.url, 'http://x').pathname];
  if (!alvo) return socket.destroy();
  alvo.handleUpgrade(req, socket, head, (ws) => alvo.emit('connection', ws, req));
});
// HOST=127.0.0.1 deixa só esta máquina entrar (padrão do app desktop); sem HOST, aceita a rede local
server.listen(PORT, process.env.HOST || undefined, () => {
  console.log(`Limb em http://localhost:${server.address().port}`);
  process.parentPort?.postMessage({ pronto: server.address().port }); // avisa o app desktop (utilityProcess)
});
