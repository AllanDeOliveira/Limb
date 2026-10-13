// Cliente estilo Discord: Gateway (WebSocket) → dispatcher Flux → stores → render.
// No cliente oficial: eventos do gateway viram ações (`eW({type:"TYPING_START",...})`)
// e cada store registra handlers por tipo (`new Store(dispatcher, {MESSAGE_CREATE(e){...}})`).

import { pack, unpack } from './etf.js';
import { criarClienteVoz, QUALIDADES } from './voz.js';

const EPOCH = 1420070400000n;
const tsOf = (id) => new Date(Number((BigInt(id) >> 22n) + EPOCH)); // a data está dentro do snowflake
const maior = (a, b) => BigInt(a) > BigInt(b);
const byId = (a, b) => (maior(b.id, a.id) ? -1 : 1);
const $ = (s) => document.querySelector(s);
// ponte nativa do app desktop (undefined no navegador); REANative = apps de antes do nome Limb
const ponte = () => window.LimbNative ?? window.REANative;
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

const store = {
  token: null, me: null,
  guilds: new Map(), users: new Map(), online: new Set(),
  guildId: null, channelId: null,
  messages: new Map(), // channelId → { list: [], hasMore }
  typing: new Map(), // channelId → Map(userId → expira em)
  readState: new Map(), // channelId → { last_message_id, mention_count }
  voiceStates: new Map(), // userId → { channel_id, self_mute, self_deaf, ... }
  speaking: new Set(), // userIds falando agora (op 5 SPEAKING)
  assistindo: null, // userId cuja tela está no palco
  replyTo: null, // mensagem sendo respondida
  conn: 'desconectado',
  search: null, // { q, total, messages, loading }
};

// ── Seletores ───────────────────────────────────────────────────────────────
const canalPorId = (id) => { for (const g of store.guilds.values()) { const c = g.channels.find((x) => x.id === id); if (c) return c; } };
const canalAtual = () => canalPorId(store.channelId);
// Sem read state, o baseline é a criação do usuário (o id dele é um snowflake = data).
// O Discord faz igual com a data de entrada no servidor: `s=fromTimestamp(e.joinedAt)`.
const lidoAte = (cid) => store.readState.get(cid)?.last_message_id ?? store.me.id;
const naoLido = (c) => c.last_message_id != null && maior(c.last_message_id, lidoAte(c.id));
const mencoesEm = (cid) => store.readState.get(cid)?.mention_count ?? 0;
const acharMsg = (cid, mid) => store.messages.get(cid)?.list.find((m) => m.id === mid);
const usuarioPorNome = (n) => { for (const u of store.users.values()) if (u.username === n) return u; };

// ── Dispatcher + stores ─────────────────────────────────────────────────────
const handlers = [];
function dispatch(action) {
  for (const h of handlers) h[action.type]?.(action);
  agendarRender();
}

handlers.push({ // ConnectionStore + GuildStore + UserStore
  CONNECTION_STATE: ({ state }) => { store.conn = state; },
  READY: ({ data }) => {
    store.me = data.user;
    store.guilds = new Map(data.guilds.map((g) => [g.id, g]));
    store.users = new Map(data.users.map((u) => [u.id, u]));
    store.online = new Set(data.presences);
    store.readState = new Map(data.read_state.map((r) => [r.channel_id, r]));
    store.messages.clear(); // sessão nova: o que perdemos vem de novo pelo REST
    if (!store.guilds.has(store.guildId)) selecionarGuild([...store.guilds.keys()][0]);
    else { carregarMensagens(store.channelId); ackar(); }
  },
  GUILD_CREATE: ({ data }) => { store.guilds.set(data.id, data); },
  CHANNEL_CREATE: ({ data }) => { store.guilds.get(data.guild_id)?.channels.push(data); },
  USER_CREATE: ({ data }) => { store.users.set(data.id, data); },
  PRESENCE_UPDATE: ({ data }) => {
    store.users.set(data.user.id, data.user);
    data.status === 'online' ? store.online.add(data.user.id) : store.online.delete(data.user.id);
  },
});

handlers.push({ // MessageStore
  LOAD_MESSAGES_SUCCESS: ({ channelId, messages, before }) => {
    const atual = before ? store.messages.get(channelId)?.list ?? [] : [];
    store.messages.set(channelId, { list: [...messages.reverse(), ...atual], hasMore: messages.length === 50 });
  },
  // Otimista: entra na hora com id provisório; o eco do gateway traz o mesmo nonce e substitui
  MESSAGE_CREATE: ({ data, optimistic }) => {
    const ch = store.messages.get(data.channel_id);
    if (ch) {
      const i = data.nonce && !optimistic ? ch.list.findIndex((m) => m.nonce === data.nonce && m.pending) : -1;
      if (i >= 0) ch.list.splice(i, 1);
      if (optimistic) ch.list.push(data);
      else if (!ch.list.some((m) => m.id === data.id)) {
        const pendentes = ch.list.filter((m) => m.pending || m.failed);
        ch.list = [...ch.list.filter((m) => !m.pending && !m.failed), data].sort(byId).concat(pendentes);
      }
    }
    if (optimistic) return;
    store.typing.get(data.channel_id)?.delete(data.author.id);
    const c = canalPorId(data.channel_id);
    if (c && (c.last_message_id == null || maior(data.id, c.last_message_id))) c.last_message_id = data.id;
  },
  MESSAGE_SEND_FAILED: ({ channelId, nonce }) => {
    const m = store.messages.get(channelId)?.list.find((x) => x.nonce === nonce);
    if (m) { m.pending = false; m.failed = true; }
  },
  MESSAGE_UPDATE: ({ data }) => {
    const ch = store.messages.get(data.channel_id);
    const i = ch?.list.findIndex((m) => m.id === data.id) ?? -1;
    if (i >= 0) ch.list[i] = { ...data, reactions: ch.list[i].reactions }; // reações têm evento próprio
  },
  MESSAGE_DELETE: ({ data }) => {
    const ch = store.messages.get(data.channel_id);
    if (!ch) return;
    ch.list = ch.list.filter((m) => m.id !== data.id);
    for (const m of ch.list) if (m.message_reference?.message_id === data.id) m.referenced_message = null;
    if (store.replyTo?.id === data.id) store.replyTo = null;
  },
  MESSAGE_REACTION_ADD: ({ data }) => {
    const m = acharMsg(data.channel_id, data.message_id);
    if (!m) return;
    const r = m.reactions.find((x) => x.emoji === data.emoji) ?? (m.reactions.push({ emoji: data.emoji, count: 0, me: false }), m.reactions.at(-1));
    r.count++;
    if (data.user_id === store.me.id) r.me = true;
  },
  MESSAGE_REACTION_REMOVE: ({ data }) => {
    const m = acharMsg(data.channel_id, data.message_id);
    const r = m?.reactions.find((x) => x.emoji === data.emoji);
    if (!r) return;
    r.count--;
    if (data.user_id === store.me.id) r.me = false;
    if (r.count <= 0) m.reactions = m.reactions.filter((x) => x !== r);
  },
  REPLY_SET: ({ message }) => { store.replyTo = message; },
});

handlers.push({ // ReadStateStore
  MESSAGE_CREATE: ({ data, optimistic }) => {
    if (optimistic) return;
    const rs = store.readState.get(data.channel_id) ?? { channel_id: data.channel_id, last_message_id: lidoAte(data.channel_id), mention_count: 0 };
    store.readState.set(data.channel_id, rs);
    if (data.author.id === store.me.id) { rs.last_message_id = data.id; return; } // o que eu mando já está lido
    if (data.mentions.includes(store.me.id)) { rs.mention_count++; notificar(data); }
    if (data.channel_id === store.channelId && document.visibilityState === 'visible') ackar();
  },
  MESSAGE_ACK: ({ data }) => {
    store.readState.set(data.channel_id, { channel_id: data.channel_id, last_message_id: data.message_id, mention_count: 0 });
  },
});

handlers.push({ // VoiceStateStore
  READY: ({ data }) => {
    store.voiceStates = new Map(data.voice_states.map((s) => [s.user_id, s]));
    voz.resetar(); // sessão nova: a conexão de voz anterior morreu com a sessão antiga
  },
  VOICE_STATE_UPDATE: ({ data }) => {
    data.channel_id ? store.voiceStates.set(data.user_id, data) : store.voiceStates.delete(data.user_id);
    if (data.user_id === store.me.id && data.channel_id === null && voz.atual()) voz.resetar(); // saiu por outra aba
  },
  VOICE_SERVER_UPDATE: ({ data }) => voz.servidorPronto(data),
  VOICE_STATE_ERROR: ({ data }) => { voz.resetar(); alert(data.message); },
});

handlers.push({ // TypingStore
  TYPING_START: ({ data }) => {
    if (data.user_id === store.me?.id) return;
    if (!store.typing.has(data.channel_id)) store.typing.set(data.channel_id, new Map());
    store.typing.get(data.channel_id).set(data.user_id, Date.now() + 10_000);
  },
});

handlers.push({ // SearchStore
  SEARCH_START: ({ q, offset }) => { store.search = { ...(offset ? store.search : { messages: [] }), q, loading: true }; },
  SEARCH_SUCCESS: ({ q, offset, total_results, messages }) => {
    if (store.search?.q !== q) return; // resposta atrasada de uma busca antiga
    store.search = { q, total: total_results, loading: false, messages: offset ? [...store.search.messages, ...messages] : messages };
  },
  SEARCH_CLEAR: () => { store.search = null; },
});

// ── REST ────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: store.token ?? '' },
    body: body && JSON.stringify(body),
  });
  if (r.status === 401) { sair(); throw new Error('Sessão expirada'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || r.statusText);
  return r.status === 204 ? null : r.json();
}

async function carregarMensagens(channelId, before) {
  if (!channelId) return;
  const qs = before ? `?before=${before}` : '';
  const messages = await api('GET', `/channels/${channelId}/messages${qs}`);
  dispatch({ type: 'LOAD_MESSAGES_SUCCESS', channelId, messages, before });
}

async function enviar(content) {
  const channelId = store.channelId, ref = store.replyTo;
  // Discord usa um snowflake como nonce; bits baixos aleatórios evitam colisão no mesmo ms
  const nonce = String(((BigInt(Date.now()) - EPOCH) << 22n) | BigInt(Math.floor(Math.random() * 4096)));
  dispatch({ type: 'REPLY_SET', message: null });
  dispatch({ type: 'MESSAGE_CREATE', optimistic: true, data: {
    id: `pending-${nonce}`, nonce, pending: true, channel_id: channelId, content, author: store.me, mentions: [], reactions: [],
    message_reference: ref ? { message_id: ref.id } : undefined, referenced_message: ref ?? undefined,
  } });
  try { await api('POST', `/channels/${channelId}/messages`, { content, nonce, message_reference: ref ? { message_id: ref.id } : undefined }); }
  catch { dispatch({ type: 'MESSAGE_SEND_FAILED', channelId, nonce }); }
}

function reagir(m, emoji) {
  const eu = m.reactions.find((r) => r.emoji === emoji)?.me;
  api(eu ? 'DELETE' : 'PUT', `/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}/@me`).catch(alert);
}

// Lido = viu o canal com a aba visível. Debounce para não mandar um ack por mensagem.
let ackTimer;
function ackar() {
  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => {
    const c = canalAtual();
    if (c && document.visibilityState === 'visible' && (naoLido(c) || mencoesEm(c.id))) {
      api('POST', `/channels/${c.id}/messages/${c.last_message_id ?? lidoAte(c.id)}/ack`).catch(() => {});
    }
  }, 300);
}

async function buscar(q, offset = 0) {
  dispatch({ type: 'SEARCH_START', q, offset });
  const qs = new URLSearchParams({ q, offset });
  const r = await api('GET', `/guilds/${store.guildId}/messages/search?${qs}`);
  dispatch({ type: 'SEARCH_SUCCESS', q, offset, ...r });
}

// ── Gateway ─────────────────────────────────────────────────────────────────
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
const gateway = {
  ws: null, timer: null, acked: true, tentativas: 0,
  sessionId: null, seq: 0,
  connect() {
    dispatch({ type: 'CONNECTION_STATE', state: 'conectando…' });
    // ETF binário, como o desktop do Discord com discord_erlpack; ?encoding=json também funciona
    const ws = (this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/gateway?encoding=etf`));
    ws.binaryType = 'arraybuffer';
    const enviar = (p) => ws.send(pack(p));
    this.enviar = enviar;
    const identify = () => { this.sessionId = null; this.seq = 0; enviar({ op: OP.IDENTIFY, d: { token: store.token } }); };
    ws.onmessage = (e) => {
      let p;
      try { p = unpack(e.data); } catch { // ex.: servidor de outra versão, que só fala JSON
        dispatch({ type: 'CONNECTION_STATE', state: 'erro: o servidor não fala a mesma versão do app' });
        return;
      }
      if (p.op === OP.HELLO) {
        this.heartbeat(p.d.heartbeat_interval);
        // como o `_doResumeOrIdentify` do Discord: com sessão, tenta retomar sem perder eventos
        if (this.sessionId) enviar({ op: OP.RESUME, d: { token: store.token, session_id: this.sessionId, seq: this.seq } });
        else identify();
      } else if (p.op === OP.INVALID_SESSION) identify();
      else if (p.op === OP.HEARTBEAT_ACK) this.acked = true;
      else if (p.op === OP.DISPATCH) {
        this.seq = p.s;
        if (p.t === 'READY') this.sessionId = p.d.session_id;
        if (p.t === 'READY' || p.t === 'RESUMED') { this.tentativas = 0; dispatch({ type: 'CONNECTION_STATE', state: 'conectado' }); }
        dispatch({ type: p.t, data: p.d });
      }
    };
    ws.onclose = (e) => {
      clearTimeout(this.timer);
      if (ws !== this.ws) return;
      if (e.code === 4004) return sair(); // token inválido
      if (e.code === 4009) this.sessionId = null; // sessão expirou no servidor: não dá para retomar
      const espera = Math.min(30_000, 1000 * 2 ** this.tentativas++);
      dispatch({ type: 'CONNECTION_STATE', state: `reconectando em ${Math.round(espera / 1000)}s` });
      this.timer = setTimeout(() => this.connect(), espera);
    };
  },
  // Primeiro beat com jitter (intervalo × aleatório), depois fixo. Sem ACK = conexão zumbi → reconecta.
  heartbeat(intervalo) {
    this.acked = true;
    const beat = () => {
      if (!this.acked) return this.ws.close(4000, 'zombie');
      this.acked = false;
      this.enviar({ op: OP.HEARTBEAT, d: this.seq });
      this.timer = setTimeout(beat, intervalo);
    };
    this.timer = setTimeout(beat, intervalo * Math.random());
  },
  // 1000 = saída intencional: o servidor encerra a sessão na hora (presença offline)
  close() { const ws = this.ws; this.ws = null; this.sessionId = null; clearTimeout(this.timer); ws?.close(1000); },
};

const voz = criarClienteVoz({
  store, dispatch,
  enviarGateway: (p) => { if (gateway.ws?.readyState === 1) gateway.enviar(p); },
  sessionId: () => gateway.sessionId,
});

// ── Navegação ───────────────────────────────────────────────────────────────
function selecionarGuild(id) {
  store.guildId = id;
  store.search = null;
  selecionarCanal(store.guilds.get(id)?.channels.find((c) => c.type !== 2)?.id);
}
function selecionarCanal(id) {
  store.channelId = id;
  store.replyTo = null;
  grudarNoFim = true;
  if (id && !store.messages.has(id)) carregarMensagens(id).catch(alert);
  ackar();
  agendarRender();
}

// ── Markdown ────────────────────────────────────────────────────────────────
// Subconjunto do Discord, sem aninhamento. Tudo vira nó DOM com textContent (sem innerHTML).
const MD = /```(?:[a-z]+\n)?([\s\S]+?)```|`([^`\n]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\|\|([^|]+?)\|\||\*([^*\n]+?)\*|\b_([^_\n]+?)_\b|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|@([a-z0-9_.]{2,32})/gi;
function markdown(texto) {
  const f = document.createDocumentFragment();
  let i = 0;
  for (const m of texto.matchAll(MD)) {
    f.append(texto.slice(i, m.index));
    i = m.index + m[0].length;
    const [bruto, bloco, code, bold, under, strike, spoiler, it1, it2, url, nome] = m;
    if (bloco != null) f.append(h('pre', {}, h('code', { textContent: bloco })));
    else if (code != null) f.append(h('code', { textContent: code }));
    else if (bold != null) f.append(h('strong', { textContent: bold }));
    else if (under != null) f.append(h('u', { textContent: under }));
    else if (strike != null) f.append(h('s', { textContent: strike }));
    else if (spoiler != null) f.append(h('span', { className: 'spoiler', textContent: spoiler, title: 'Spoiler', onclick: (e) => e.target.classList.add('show') }));
    else if (it1 != null || it2 != null) f.append(h('em', { textContent: it1 ?? it2 }));
    else if (url) f.append(h('a', { href: url, textContent: url, target: '_blank', rel: 'noopener noreferrer' }));
    else {
      const u = usuarioPorNome(nome.toLowerCase());
      f.append(u ? h('span', { className: `mention${u.id === store.me.id ? ' me' : ''}`, textContent: `@${u.username}` }) : bruto);
    }
  }
  f.append(texto.slice(i));
  return f;
}

// ── Render ──────────────────────────────────────────────────────────────────
// h() monta elementos com textContent: conteúdo de usuário nunca vira HTML
// `cond && h(...)` vira false quando não aplica: nunca pode virar o texto "false"
const nos = (filhos) => filhos.flat().filter((f) => f != null && f !== false);
function h(tag, props = {}, ...filhos) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...nos(filhos));
  return el;
}
const trocar = (el, ...filhos) => el.replaceChildren(...nos(filhos));
const cor = (id) => `hsl(${Number(BigInt(id) % 360n)} 55% 45%)`;
const nome = (id) => store.users.get(id)?.username ?? '?';
const hora = (id) => tsOf(id).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const badge = (n) => n > 0 && h('span', { className: 'badge', textContent: n > 99 ? '99+' : String(n) });

let pendente = false, grudarNoFim = true, manterTopo = false, ultimoTotal = 0;

// prompt() não existe no Electron: diálogo próprio com <dialog> (Enter confirma, Shift+Enter quebra linha, Esc cancela)
function pedirTexto(titulo, inicial = '', max = 100) {
  const d = $('#pedir'), campo = d.querySelector('textarea');
  d.querySelector('span').textContent = titulo;
  campo.value = inicial;
  campo.maxLength = max;
  d.returnValue = '';
  d.showModal();
  campo.select();
  return new Promise((ok) => d.addEventListener('close', () => ok(d.returnValue === 'ok' ? campo.value.trim() || null : null), { once: true }));
}

// Menção com a janela em segundo plano vira notificação do sistema (toast no Windows, no app desktop)
function notificar(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const n = new Notification(`${m.author.username} em #${canalPorId(m.channel_id)?.name ?? '?'}`, { body: m.content.slice(0, 200), tag: m.channel_id });
  n.onclick = () => { ponte()?.focar(); window.focus(); selecionarCanal(m.channel_id); n.close(); };
}
function agendarRender() {
  if (pendente) return;
  pendente = true;
  const fazer = () => { if (!pendente) return; pendente = false; render(); };
  requestAnimationFrame(fazer);
  setTimeout(fazer, 150); // janela minimizada não tem rAF, mas o título (menções na barra de tarefas) precisa mudar
}

// Links de saída: sempre visíveis, até antes de conectar (senão uma falha deixa a janela sem saída)
const linksConta = () => [
  h('a', { href: '#', textContent: 'sair', onclick: sair }),
  ponte()?.abrirConexao && [' · ', h('a', { href: '#', textContent: 'servidor', title: 'Hospedar ou entrar no servidor de um amigo',
    onclick: (e) => { e.preventDefault(); ponte().abrirConexao(); } })],
];

function render() {
  if (!store.me) { // ainda sem READY: mostra o estado da conexão e como sair
    $('#conn').textContent = store.conn;
    $('#chanName').textContent = store.conn.startsWith('erro') ? 'Não foi possível conectar' : 'Conectando…';
    trocar($('#me'), linksConta());
    return;
  }
  const guild = store.guilds.get(store.guildId);
  const canal = canalAtual();

  let totalMencoes = 0;
  trocar($('#guilds'),
    ...[...store.guilds.values()].map((g) => {
      const mencoes = g.channels.reduce((n, c) => n + mencoesEm(c.id), 0);
      totalMencoes += mencoes;
      return h('div', { className: 'gwrap' },
        g.id !== store.guildId && g.channels.some(naoLido) && h('span', { className: 'pill' }),
        h('button', {
          className: `guild${g.id === store.guildId ? ' on' : ''}`, title: g.name,
          textContent: g.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3),
          onclick: () => selecionarGuild(g.id),
        }),
        badge(mencoes),
      );
    }),
    h('button', { className: 'guild', title: 'Criar servidor', textContent: '+', onclick: async () => {
      const n = await pedirTexto('Nome do servidor'); if (n) selecionarGuild((await api('POST', '/guilds', { name: n })).id);
    } }),
  );
  document.title = `${totalMencoes ? `(${totalMencoes}) ` : ''}Limb`;
  if (totalMencoes !== ultimoTotal) { ultimoTotal = totalMencoes; ponte()?.atencao(totalMencoes); } // app desktop: pisca na barra de tarefas

  $('#guildName').textContent = guild?.name ?? '';
  const canais = guild?.channels ?? [];
  trocar($('#channels'),
    ...canais.filter((c) => c.type !== 2).map((c) => h('button', {
      className: `chan${c.id === store.channelId ? ' on' : ''}${naoLido(c) ? ' unread' : ''}`, onclick: () => selecionarCanal(c.id),
    }, h('span', { textContent: c.name }), badge(mencoesEm(c.id)))),
    ...canais.filter((c) => c.type === 2).map(renderCanalVoz),
    guild && h('div', { className: 'adds' },
      h('button', { className: 'add', textContent: '+ texto', onclick: async () => {
        const n = await pedirTexto('Nome do canal de texto'); if (n) selecionarCanal((await api('POST', `/guilds/${guild.id}/channels`, { name: n })).id);
      } }),
      h('button', { className: 'add', textContent: '+ voz', onclick: async () => {
        const n = await pedirTexto('Nome do canal de voz'); if (n) await api('POST', `/guilds/${guild.id}/channels`, { name: n, type: 2 });
      } }),
    ),
  );
  renderPainelVoz();
  renderPalco();
  trocar($('#me'), h('b', { textContent: store.me.username }), ' · ', linksConta());
  $('#chanName').textContent = canal ? `# ${canal.name}` : '';
  $('#conn').textContent = store.conn;
  $('#input').placeholder = canal ? `Conversar em #${canal.name}` : '';
  $('#reply').hidden = !store.replyTo;
  if (store.replyTo) trocar($('#reply'),
    'Respondendo a ', h('b', { textContent: store.replyTo.author.username }),
    h('button', { textContent: '✕', title: 'Cancelar resposta', onclick: () => dispatch({ type: 'REPLY_SET', message: null }) }),
  );

  renderMensagens();
  renderTyping();
  trocar($('#right'), ...(store.search ? renderBusca() : renderMembros()));
  $('#right').classList.toggle('searching', !!store.search);
}

// Canal de voz: clicar entra; embaixo, quem está nele (anel verde = falando)
function renderCanalVoz(c) {
  const dentro = [...store.voiceStates.values()].filter((s) => s.channel_id === c.id);
  return h('div', {},
    h('button', { className: `chan voice${voz.atual()?.channelId === c.id ? ' on' : ''}`, onclick: () => voz.entrar(c) }, h('span', { textContent: c.name })),
    dentro.map((s) => h('div', {
      className: `vuser${store.speaking.has(s.user_id) ? ' speaking' : ''}`,
      // clicar em outra pessoa silencia só para você (setLocalMute)
      title: s.user_id === store.me.id ? '' : voz.mutadoLocal(s.user_id) ? 'Reativar áudio desta pessoa' : 'Silenciar só para mim',
      onclick: () => { if (s.user_id !== store.me.id) voz.alternarMutoLocal(s.user_id); },
    },
      h('span', { className: 'av', style: `background:${cor(s.user_id)}`, textContent: nome(s.user_id)[0].toUpperCase() }),
      h('span', { className: 'vname', textContent: nome(s.user_id) }),
      s.self_stream && h('button', {
        className: 'ao-vivo', textContent: 'AO VIVO', title: `Assistir a tela de ${nome(s.user_id)}`,
        onclick: (e) => { e.stopPropagation(); assistir(s.user_id); },
      }),
      s.self_deaf ? h('span', { title: 'Surdo', textContent: '🔇' }) : s.self_mute && h('span', { title: 'Mudo', textContent: '🎙️✖' }),
      voz.mutadoLocal(s.user_id) && h('span', { title: 'Silenciado por você', textContent: '🔈✖' }),
    )),
  );
}

function renderPainelVoz() {
  const a = voz.atual();
  $('#voice').hidden = !a;
  if (!a) return;
  trocar($('#voice'),
    h('div', { className: 'vstatus' },
      h('b', { className: a.status === 'conectado' ? 'ok' : '', textContent: a.status === 'conectado' ? 'Voz conectada' : 'Conectando…' }),
      h('small', { textContent: `${canalPorId(a.channelId)?.name ?? ''} · ${a.conectados} com áudio` }),
      a.transmitindo && h('small', { className: 'ok', textContent: `Transmitindo · ${a.qualidade}` }),
      a.avisoMudo && h('small', { className: 'aviso', role: 'status', textContent: 'Você está mudo' })),
    h('button', { className: a.mute ? 'off' : '', title: a.mute ? 'Ativar microfone' : 'Silenciar', ariaPressed: String(a.mute), textContent: '🎙️', onclick: voz.alternarMudo }),
    h('button', { className: a.deaf ? 'off' : '', title: a.deaf ? 'Ativar áudio' : 'Ensurdecer', ariaPressed: String(a.deaf), textContent: '🎧', onclick: voz.alternarSurdo }),
    h('button', {
      className: a.transmitindo ? 'on' : '', title: a.transmitindo ? 'Parar de compartilhar' : 'Compartilhar tela',
      ariaPressed: String(a.transmitindo), textContent: '🖥️', onclick: () => (voz.atual()?.transmitindo ? voz.pararTela() : escolherTela()), // estado na hora do clique
    }),
    h('button', { className: 'hangup', title: 'Desconectar', textContent: '📞', onclick: voz.sair }),
  );
}

// ── Palco: assistir a tela de alguém ─────────────────────────────────────────
// Elementos fixos no HTML (não recriados a cada render): recriar o <video> faria a imagem piscar.
// Como no Discord: clicar na transmissão de alguém entra no canal dessa pessoa, se preciso
async function assistir(userId) {
  const canal = canalPorId(store.voiceStates.get(userId)?.channel_id);
  if (!canal) return;
  if (voz.atual()?.channelId !== canal.id) await voz.entrar(canal);
  if (voz.atual()?.channelId !== canal.id) return; // microfone negado
  store.assistindo = userId;
  agendarRender();
}
function renderPalco() {
  const quem = store.assistindo;
  const ativo = quem && store.voiceStates.get(quem)?.self_stream;
  if (quem && !ativo) store.assistindo = null; // a pessoa parou de transmitir ou saiu
  const video = $('#palcoVideo');
  $('main').classList.toggle('assistindo', !!ativo);
  $('#palco').hidden = !ativo;
  if (!ativo) { if (video.srcObject) video.srcObject = null; return; }
  const stream = voz.tela(quem);
  if (video.srcObject !== stream) video.srcObject = stream;
  video.hidden = !stream;
  $('#palcoEspera').hidden = !!stream;
  $('#palcoNome').textContent = quem === store.me.id ? 'Sua tela (prévia)' : nome(quem);
  video.muted = quem === store.me.id || voz.surdo(); // a própria tela nunca toca: eco
  const [faixa] = stream?.getVideoTracks() ?? [];
  const cfg = faixa?.getSettings();
  $('#palcoInfo').textContent = cfg?.height ? `${cfg.width}×${cfg.height}${cfg.frameRate ? ` · ${Math.round(cfg.frameRate)} fps` : ''}` : '';
}
$('#palcoVol').addEventListener('input', (e) => { $('#palcoVideo').volume = Number(e.target.value); });
$('#palcoFechar').addEventListener('click', () => { store.assistindo = null; agendarRender(); });
$('#palcoCheia').addEventListener('click', () => {
  document.fullscreenElement ? document.exitFullscreen() : $('#palco').requestFullscreen().catch(() => {});
});
$('#palcoVideo').addEventListener('dblclick', () => $('#palcoCheia').click());

// ── Escolher o que compartilhar ──────────────────────────────────────────────
// App desktop: seletor próprio com miniaturas (o Electron não tem o do Chrome). Navegador: o do Chrome.
const telaDlg = $('#telaDlg');
for (const [id, q] of Object.entries(QUALIDADES)) telaDlg.querySelector('select').append(h('option', { value: id, textContent: q.nome, selected: id === '1080p30' }));
async function escolherTela() {
  const nativo = ponte();
  const form = telaDlg.querySelector('form');
  // som do sistema: Windows no app desktop (loopback); no navegador, o Chrome decide (aba/tela)
  $('#telaAudioCampo').hidden = !!nativo && nativo.plataforma !== 'win32';
  $('#telaDica').textContent = nativo
    ? 'Clique na tela ou janela. O som do computador inclui tudo que toca nele, até a voz da chamada: use fone de ouvido.'
    : 'O navegador vai abrir a própria janela de escolha.';
  telaDlg.toggleAttribute('data-desktop', !!nativo);
  trocar($('#telaFontes'));
  const compartilhar = async (fonteId) => {
    const opcoes = { qualidade: form.qualidade.value, comAudio: form.audio.checked && !$('#telaAudioCampo').hidden };
    telaDlg.close();
    try {
      if (fonteId && !(await nativo.escolherFonte(fonteId, opcoes.comAudio))) throw new Error('fonte não está mais disponível');
      await voz.compartilharTela(opcoes);
    } catch (e) {
      if (e.name !== 'NotAllowedError') alert(`Não foi possível compartilhar: ${e.message}`); // NotAllowed = cancelou
    }
  };
  if (nativo) {
    const fontes = await nativo.fontesDeTela();
    trocar($('#telaFontes'), fontes.map((f) => h('button', { type: 'button', className: 'fonte', title: f.nome, onclick: () => compartilhar(f.id) },
      h('img', { src: f.miniatura, alt: '' }), h('span', { textContent: `${f.tela ? '🖥️' : '🪟'} ${f.nome}` }))));
  }
  telaDlg.onclose = () => { if (telaDlg.returnValue === 'ok' && !nativo) compartilhar(); };
  telaDlg.returnValue = '';
  telaDlg.showModal();
}

// Mesma regra visual do Discord: mesmo autor em até 7 min vira continuação (sem avatar/nome)
const agrupa = (ant, m) => ant && !ant.failed && ant.author.id === m.author.id && !m.message_reference
  && !String(ant.id).startsWith('pending') && !String(m.id).startsWith('pending')
  && tsOf(m.id) - tsOf(ant.id) < 7 * 60_000;

function renderMensagem(m, ant) {
  const meu = m.author.id === store.me.id, real = !m.pending && !m.failed;
  const grupo = agrupa(ant, m);
  const ref = m.message_reference && h('div', { className: 'ref' },
    m.referenced_message
      ? [h('b', { textContent: `@${m.referenced_message.author.username} ` }), markdown(m.referenced_message.content.slice(0, 100))]
      : h('i', { textContent: 'Mensagem original apagada' }));
  return h('div', { className: `msg${grupo ? ' cont' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${m.mentions?.includes(store.me.id) ? ' mentioned' : ''}` },
    ref,
    !grupo && h('div', { className: 'av', style: `background:${cor(m.author.id)}`, textContent: m.author.username[0].toUpperCase() }),
    !grupo && h('span', { className: 'who', textContent: m.author.username }),
    !grupo && h('span', { className: 'when', textContent: m.pending ? 'enviando…' : m.failed ? 'falhou' : hora(m.id) }),
    h('div', { className: 'body' }, markdown(m.content), m.edited_timestamp && h('span', { className: 'edited', textContent: ' (editado)' })),
    m.reactions?.length > 0 && h('div', { className: 'reactions' }, m.reactions.map((r) => h('button', {
      className: `react${r.me ? ' me' : ''}`, textContent: `${r.emoji} ${r.count}`, disabled: !real, onclick: () => reagir(m, r.emoji),
    }))),
    real && h('div', { className: 'tools' },
      EMOJIS.map((e) => h('button', { textContent: e, title: `Reagir com ${e}`, onclick: () => reagir(m, e) })),
      h('button', { textContent: 'Responder', onclick: () => { dispatch({ type: 'REPLY_SET', message: m }); $('#input').focus(); } }),
      meu && h('button', { textContent: 'Editar', onclick: async () => {
        const c = await pedirTexto('Editar mensagem', m.content, 2000);
        if (c && c !== m.content) api('PATCH', `/channels/${m.channel_id}/messages/${m.id}`, { content: c }).catch(alert);
      } }),
      meu && h('button', { textContent: 'Apagar', onclick: () => {
        if (confirm('Apagar mensagem?')) api('DELETE', `/channels/${m.channel_id}/messages/${m.id}`).catch(alert);
      } }),
    ),
  );
}

function renderMensagens() {
  const box = $('#messages');
  const ch = store.messages.get(store.channelId);
  const noFim = grudarNoFim || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const alturaAntes = box.scrollHeight, topoAntes = box.scrollTop;
  const lista = ch?.list ?? [];
  trocar(box,
    ch?.hasMore && h('button', { className: 'more', textContent: 'Carregar mensagens antigas', onclick: () => {
      grudarNoFim = false; manterTopo = true; carregarMensagens(store.channelId, lista.find((m) => !m.pending)?.id);
    } }),
    ...lista.map((m, i) => renderMensagem(m, lista[i - 1])),
  );
  if (manterTopo) { box.scrollTop = topoAntes + box.scrollHeight - alturaAntes; manterTopo = false; }
  else if (noFim) box.scrollTop = box.scrollHeight;
  grudarNoFim = false;
}

function renderTyping() {
  const agora = Date.now();
  const quem = [...(store.typing.get(store.channelId) ?? [])].filter(([, exp]) => exp > agora).map(([id]) => nome(id));
  $('#typing').textContent = quem.length ? `${quem.join(', ')} ${quem.length > 1 ? 'estão' : 'está'} digitando…` : '';
}

function renderMembros() {
  const users = [...store.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  const linha = (u) => h('div', { className: `member${store.online.has(u.id) ? '' : ' off'}` }, h('span', { className: 'dot' }), u.username);
  const on = users.filter((u) => store.online.has(u.id)), off = users.filter((u) => !store.online.has(u.id));
  return [h('h4', { textContent: `Online — ${on.length}` }), ...on.map(linha), h('h4', { textContent: `Offline — ${off.length}` }), ...off.map(linha)];
}

function renderBusca() {
  const s = store.search;
  const canalNome = (id) => canalPorId(id)?.name ?? '?';
  return [
    h('h4', { textContent: s.loading && !s.messages.length ? 'Buscando…' : `${s.total ?? 0} resultado(s)` }),
    h('button', { className: 'add', textContent: 'Fechar busca', onclick: () => { $('#search').value = ''; dispatch({ type: 'SEARCH_CLEAR' }); } }),
    h('div', { className: 'results' }, s.messages.map((m) => h('div', { className: 'hit', onclick: () => selecionarCanal(m.channel_id) },
      h('small', { textContent: `#${canalNome(m.channel_id)} · ${m.author.username} · ${hora(m.id)}` }),
      h('div', {}, markdown(m.content)),
    ))),
    s.messages.length < (s.total ?? 0) && h('button', { className: 'add', textContent: 'Mais resultados', onclick: () => buscar(s.q, s.messages.length).catch(alert) }),
  ];
}
setInterval(() => { if (store.typing.size) renderTyping(); }, 1000);

// ── Eventos da página ───────────────────────────────────────────────────────
let ultimoTyping = 0;
const input = $('#input');
const ajustarAltura = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
input.addEventListener('input', () => {
  ajustarAltura();
  if (!store.channelId || !input.value.trim() || Date.now() - ultimoTyping < 8000) return;
  ultimoTyping = Date.now();
  api('POST', `/channels/${store.channelId}/typing`).catch(() => {});
});
// Enter envia, Shift+Enter quebra linha; Esc cancela a resposta
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && store.replyTo) dispatch({ type: 'REPLY_SET', message: null });
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  const content = input.value.trim();
  if (!content || !store.channelId) return;
  input.value = '';
  ajustarAltura();
  ultimoTyping = 0;
  grudarNoFim = true;
  enviar(content);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  q ? buscar(q).catch(alert) : dispatch({ type: 'SEARCH_CLEAR' });
});
$('#pedir textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#pedir').close('ok'); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.me) ackar(); });

// ── Sessão ──────────────────────────────────────────────────────────────────
const salvo = { get: () => { try { return localStorage.getItem('token'); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); } catch {} } };

function entrar(token) {
  store.token = token;
  salvo.set(token);
  $('#login').hidden = true;
  $('#app').hidden = false;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  gateway.connect();
}
function sair(e) {
  e?.preventDefault?.();
  voz.sair();
  gateway.close();
  salvo.set(null);
  Object.assign(store, { token: null, me: null, guildId: null, channelId: null, search: null, replyTo: null });
  store.messages.clear();
  $('#app').hidden = true;
  $('#login').hidden = false;
}
$('#login form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try { entrar((await api('POST', '/login', { username: f.username.value, password: f.password.value, invite: f.invite.value || undefined })).token); }
  catch (err) { $('#login .error').textContent = err.message; }
  f.password.value = '';
});
// Servidor com código de convite: mostra o campo
fetch('/api/info').then((r) => r.json()).then((i) => { $('#conviteCampo').hidden = !i.convite; }).catch(() => {});
// Convite colado no app desktop chega como #convite=…: preenche o campo e tira do endereço
const conviteUrl = /[#&]convite=([^&]+)/.exec(location.hash)?.[1];
if (conviteUrl) {
  $('#login form').invite.value = decodeURIComponent(conviteUrl);
  history.replaceState(null, '', location.pathname + location.search);
}
// App desktop: trocar de servidor (hospedar aqui ou entrar no de um amigo)
if (ponte()?.abrirConexao) {
  $('#trocarServidor').hidden = false;
  $('#trocarServidor').addEventListener('click', () => ponte().abrirConexao());
}
salvo.get() ? entrar(salvo.get()) : ($('#login').hidden = false);
