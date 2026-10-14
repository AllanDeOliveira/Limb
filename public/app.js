// Cliente estilo Discord: Gateway (WebSocket) → dispatcher Flux → stores → render.
// No cliente oficial: eventos do gateway viram ações (`eW({type:"TYPING_START",...})`)
// e cada store registra handlers por tipo (`new Store(dispatcher, {MESSAGE_CREATE(e){...}})`).

import { criarClienteVoz, RESOLUCOES, TAXAS, codecsDeVideo, estimativaTela } from './voz.js';
import { opcoesDispositivos } from './dispositivos.js';
import { criarSons } from './sons.js';

const EPOCH = 1420070400000n;
const tsOf = (id) => new Date(Number((BigInt(id) >> 22n) + EPOCH)); // a data está dentro do snowflake
const maior = (a, b) => BigInt(a) > BigInt(b);
const byId = (a, b) => (maior(b.id, a.id) ? -1 : 1);
const $ = (s) => document.querySelector(s);
// ponte nativa do app desktop (undefined no navegador)
const ponte = () => window.LimbNative;
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
// Ações que mudam o que a lista de mensagens mostra. As outras (fala na chamada, digitando, presença…)
// redesenham o resto da tela sem reconstruir as mensagens.
const MUDA_MENSAGENS = new Set(['READY', 'LOAD_MESSAGES_SUCCESS', 'MESSAGE_CREATE', 'MESSAGE_SEND_FAILED', 'MESSAGE_UPDATE',
  'MESSAGE_DELETE', 'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE', 'USER_CREATE', 'PRESENCE_UPDATE']);
let versaoMensagens = 0;
function dispatch(action) {
  for (const h of handlers) h[action.type]?.(action);
  if (MUDA_MENSAGENS.has(action.type)) versaoMensagens++;
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
    if (data.mentions.includes(store.me.id)) {
      rs.mention_count++; notificar(data);
      // lendo o canal agora, com a janela na frente: a menção já está na cara, não precisa de som
      if (!(data.channel_id === store.channelId && document.visibilityState === 'visible' && document.hasFocus())) sons.tocar('mencao');
    }
    if (data.channel_id === store.channelId && document.visibilityState === 'visible') ackar();
  },
  MESSAGE_ACK: ({ data }) => {
    store.readState.set(data.channel_id, { channel_id: data.channel_id, last_message_id: data.message_id, mention_count: 0 });
  },
});

handlers.push({ // VoiceStateStore
  READY: ({ data }) => {
    store.voiceStates = new Map(data.voice_states.map((s) => [s.user_id, s]));
    if (voz.atual()) sons.tocar('desconectado'); // estava numa chamada: ela caiu junto
    voz.resetar(); // sessão nova: a conexão de voz anterior morreu com a sessão antiga
  },
  VOICE_STATE_UPDATE: ({ data }) => {
    const antes = store.voiceStates.get(data.user_id); // lido antes de atualizar: é a comparação que dá o som
    data.channel_id ? store.voiceStates.set(data.user_id, data) : store.voiceStates.delete(data.user_id);
    // saiu por outra aba; só se o null é do canal em que estou (um atrasado do canal anterior não derruba o atual)
    if (data.user_id === store.me.id && data.channel_id === null && voz.atual()?.channelId === antes?.channel_id) voz.resetar();
    somDeVoz(antes, data);
  },
  VOICE_SERVER_UPDATE: ({ data }) => voz.servidorPronto(data),
  VOICE_STATE_ERROR: ({ data }) => { voz.resetar(); avisarErro(data.message); },
});

// Sons de quem entra, sai ou transmite no MEU canal de voz. Só mudanças ao vivo: o READY já traz quem
// está em cada canal (sem VOICE_STATE_UPDATE), quem já estava no canal em que eu entrei não muda de
// estado, e os eventos reenviados no RESUME são passado.
function somDeVoz(antes, depois) {
  const meu = voz.atual()?.channelId;
  if (!meu || gateway.retomando) return;
  const eu = depois.user_id === store.me?.id;
  const estava = antes?.channel_id === meu, esta = depois.channel_id === meu;
  if (!eu && !estava && esta) sons.tocar('outroEntrou');
  else if (!eu && estava && !esta) sons.tocar('outroSaiu');
  // inclusive a minha transmissão: o servidor devolve o meu próprio estado também
  else if (estava && esta && !!antes.self_stream !== !!depois.self_stream) sons.tocar(depois.self_stream ? 'transmissaoInicio' : 'transmissaoFim');
}

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
  const token = store.token;
  const r = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: token ?? '' },
    body: body && JSON.stringify(body),
  });
  // token revogado ou vencido; resposta atrasada de antes de sair não conta
  if (r.status === 401) { if (token && token === store.token) sessaoTerminou(); throw new Error('Sua sessão terminou'); }
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
  api(eu ? 'DELETE' : 'PUT', `/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}/@me`).catch(avisarErro);
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
  retomando: false, // entre o RESUME e o RESUMED: chegam os eventos perdidos, que não devem tocar som
  connect() {
    dispatch({ type: 'CONNECTION_STATE', state: 'conectando…' });
    const ws = (this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/gateway`));
    const enviar = (p) => ws.send(JSON.stringify(p));
    this.enviar = enviar;
    const identify = () => { this.sessionId = null; this.seq = 0; enviar({ op: OP.IDENTIFY, d: { token: store.token } }); };
    ws.onmessage = (e) => {
      const p = JSON.parse(e.data);
      if (p.op === OP.HELLO) {
        this.heartbeat(p.d.heartbeat_interval);
        // como o `_doResumeOrIdentify` do Discord: com sessão, tenta retomar sem perder eventos
        this.retomando = !!this.sessionId;
        if (this.sessionId) enviar({ op: OP.RESUME, d: { token: store.token, session_id: this.sessionId, seq: this.seq } });
        else identify();
      } else if (p.op === OP.INVALID_SESSION) identify();
      else if (p.op === OP.HEARTBEAT_ACK) this.acked = true;
      else if (p.op === OP.DISPATCH) {
        this.seq = p.s;
        if (p.t === 'READY') this.sessionId = p.d.session_id;
        if (p.t === 'READY' || p.t === 'RESUMED') { this.tentativas = 0; this.retomando = false; dispatch({ type: 'CONNECTION_STATE', state: 'conectado' }); }
        dispatch({ type: p.t, data: p.d });
      }
    };
    ws.onclose = (e) => {
      clearTimeout(this.timer);
      if (ws !== this.ws) return;
      if (e.code === 4004) return sessaoTerminou(); // token revogado, vencido ou inválido
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

// Sons da chamada: saem no mesmo alto-falante escolhido para a voz
const sons = criarSons({ saida: () => voz.ajustes.prefs().saida });
const voz = criarClienteVoz({
  store, dispatch, avisarErro,
  enviarGateway: (p) => { if (gateway.ws?.readyState === 1) gateway.enviar(p); },
  sessionId: () => gateway.sessionId,
  tocar: sons.tocar,
});

// ── Navegação ───────────────────────────────────────────────────────────────
function selecionarGuild(id) {
  store.guildId = id;
  store.search = null;
  selecionarCanal(store.guilds.get(id)?.channels.find((c) => c.type !== 2)?.id);
}
function selecionarCanal(id) {
  if (id && id !== store.channelId) document.body.classList.remove('nav');
  store.channelId = id;
  store.replyTo = null;
  msgSel = null;
  grudarNoFim = true;
  if (id && !store.messages.has(id)) carregarMensagens(id).catch(avisarErro);
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
// Claridade 30%: letra branca fica acima de 4,5:1 em qualquer matiz (com 34%, os amarelos davam 4,06:1)
const cor = (id) => `hsl(${Number(BigInt(id) % 360n)} 50% 30%)`;
const nome = (id) => store.users.get(id)?.username ?? '?';
const avatar = (id, letra) => h('span', { className: 'av', style: `background:${cor(id)}`, textContent: (letra ?? nome(id))[0].toUpperCase(), ariaHidden: 'true' });

// Ícones em traço (SVG): emoji mudam de cara em cada sistema e viram o nome do botão no leitor de tela
const ICONES = {
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  voz: 'M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  semSom: 'M11 5 6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  micOff: 'M2 2l20 20M18.9 13.2A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M12 19v3',
  fone: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3',
  foneOff: 'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 15.4-6.4M21 12v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3M2 2l20 20',
  tela: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 21h8M12 17v4',
  janela: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM2 9h20',
  desligar: 'M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-3.3-2.7m-2.7-3.3a19.8 19.8 0 0 1-3.1-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.4 2.1L8.1 9.9M22 2 2 22',
  mais: 'M12 5v14M5 12h14',
  servidor: 'M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zM6 6h.01M6 18h.01',
  x: 'M18 6 6 18M6 6l12 12',
  responder: 'M9 17l-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4',
  editar: 'M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z',
  apagar: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  marca: 'M8 3v18M8 15c0-4 3-6.5 8.5-7.5M16.5 7.5 14.5 4M16.5 7.5l3.5.5',
  ajustes: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  conta: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
  convidar: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M19 8v6M22 11h-6',
};
function icone(nomeIcone, tam = 20) {
  const SVG = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: tam, height: tam, 'aria-hidden': 'true', class: 'ico' })) s.setAttribute(k, v);
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', ICONES[nomeIcone]);
  s.append(p);
  return s;
}
// Botão só de ícone: o rótulo vai no aria-label e no title (dica do mouse)
const botaoIcone = (ic, rotulo, props = {}) => h('button', { type: 'button', ...props, className: `ib ${props.className ?? ''}`, title: rotulo, ariaLabel: rotulo }, icone(ic, props.tam ?? 20));

// "Hoje às 16:15" / "Ontem às 16:15" / "12/10/2026 16:15"; a data completa fica no title
const diaDe = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const horaCurta = (id) => tsOf(id).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataCompleta = (id) => tsOf(id).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
function hora(id) {
  const d = tsOf(id), dias = Math.round((diaDe(new Date()) - diaDe(d)) / 86_400_000);
  if (dias === 0) return `Hoje às ${horaCurta(id)}`;
  if (dias === 1) return `Ontem às ${horaCurta(id)}`;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).replace(',', '');
}
const badge = (n) => n > 0 && h('span', { className: 'badge', textContent: n > 99 ? '99+' : String(n) });

let pendente = false, grudarNoFim = true, manterTopo = false, ultimoTotal = 0;
let msgSel = null; // mensagem com as ações abertas por toque

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

// confirm() também não: mesmo diálogo, com o botão do perigo nomeando a ação. Cancelar recebe o foco ao abrir.
function confirmar(texto, acao) {
  const d = $('#confirmar');
  $('#confirmarTexto').textContent = texto;
  d.querySelector('.perigo').textContent = acao;
  d.returnValue = '';
  d.showModal();
  return new Promise((ok) => d.addEventListener('close', () => ok(d.returnValue === 'ok'), { once: true }));
}
// Erro de uma ação (no lugar do alert(), que trava a página): aviso no canto, some sozinho
let timerToast = 0;
function avisarErro(e) {
  const t = $('#toast');
  t.textContent = e?.message ?? String(e);
  if (t.matches(':popover-open')) t.hidePopover();
  t.showPopover(); // de novo: fica acima de um diálogo aberto depois do erro anterior
  clearTimeout(timerToast);
  timerToast = setTimeout(() => t.hidePopover(), 6000);
}

// Menção com a janela em segundo plano vira notificação do sistema (toast no Windows, no app desktop)
function notificar(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const n = new Notification(`${m.author.username} em #${canalPorId(m.channel_id)?.name ?? '?'}`, { body: m.content.slice(0, 200), tag: m.channel_id, silent: true }); // o som é o 'mencao' do sons.js, que respeita as preferências
  n.onclick = () => { ponte()?.focar(); window.focus(); selecionarCanal(m.channel_id); n.close(); };
}
function agendarRender() {
  if (pendente) return;
  pendente = true;
  const fazer = () => { if (!pendente) return; pendente = false; render(); };
  requestAnimationFrame(fazer);
  setTimeout(fazer, 150); // janela minimizada não tem rAF, mas o título (menções na barra de tarefas) precisa mudar
}

// Conta e trocar de servidor: sempre visíveis, até antes de conectar (senão uma falha deixa a janela sem saída).
// Sair da conta fica dentro de "Minha conta": ao lado dos ajustes, um clique errado derrubava a conta e a chamada.
const botoesConta = () => [
  botaoIcone('ajustes', 'Voz e áudio', { onclick: abrirAjustesAudio }),
  botaoIcone('conta', 'Minha conta', { onclick: abrirConta }),
  ponte()?.abrirConexao && botaoIcone('servidor', 'Trocar de servidor', { onclick: abrirServidores }),
];
const statusConexao = () => (store.conn === 'conectado' ? 'online' : store.conn);
function painelMe() {
  return [
    store.me && avatar(store.me.id, store.me.username),
    h('div', { className: 'quem' },
      h('b', { textContent: store.me?.username ?? 'Limb' }),
      h('small', { className: store.conn === 'conectado' ? 'ok' : '', textContent: statusConexao() })),
    ...botoesConta(), // h()/trocar() achatam só um nível
  ];
}

function render() {
  if (!store.me) { // ainda sem READY: mostra o estado da conexão e como sair
    $('#conn').textContent = store.conn;
    $('#chanName').textContent = 'Conectando…';
    trocar($('#me'), painelMe());
    return;
  }
  const guild = store.guilds.get(store.guildId);
  const canal = canalAtual();

  let totalMencoes = 0;
  trocar($('#guilds'),
    h('span', { className: 'marca-ico', title: 'Limb' }, icone('marca', 26)),
    h('span', { className: 'sep' }),
    ...[...store.guilds.values()].map((g) => {
      const mencoes = g.channels.reduce((n, c) => n + mencoesEm(c.id), 0);
      totalMencoes += mencoes;
      const ativo = g.id === store.guildId;
      return h('div', { className: `gwrap${ativo ? ' ativo' : ''}` },
        !ativo && g.channels.some(naoLido) && h('span', { className: 'pill' }),
        h('button', {
          className: `guild${ativo ? ' on' : ''}`, title: g.name, ariaLabel: g.name, ariaCurrent: ativo ? 'true' : null,
          // duas iniciais: "Amigos" vira "Am", e não "A" igual ao avatar de quem se chama Allan
          textContent: (g.name.trim().split(/\s+/).length > 1 ? g.name.trim().split(/\s+/).map((w) => w[0]).join('') : g.name.trim()).slice(0, 2),
          onclick: () => selecionarGuild(g.id),
        }),
        badge(mencoes),
      );
    }),
    h('button', { className: 'guild criar', title: 'Criar servidor', ariaLabel: 'Criar servidor', onclick: async () => {
      const n = await pedirTexto('Nome do servidor'); if (n) selecionarGuild((await api('POST', '/guilds', { name: n })).id);
    } }, icone('mais', 22)),
  );
  document.title = `${totalMencoes ? `(${totalMencoes}) ` : ''}Limb`;
  if (totalMencoes !== ultimoTotal) { ultimoTotal = totalMencoes; ponte()?.atencao(totalMencoes); } // app desktop: pisca na barra de tarefas

  $('#guildName').textContent = guild?.name ?? '';
  const canais = guild?.channels ?? [];
  trocar($('#channels'),
    guild && h('div', { className: 'grupo' }, h('span', { textContent: 'Canais de texto' }),
      botaoIcone('mais', 'Criar canal de texto', { tam: 16, onclick: async () => {
        const n = await pedirTexto('Nome do canal de texto'); if (n) selecionarCanal((await api('POST', `/guilds/${guild.id}/channels`, { name: n })).id);
      } })),
    ...canais.filter((c) => c.type !== 2).map((c) => h('button', {
      className: `chan${c.id === store.channelId ? ' on' : ''}${naoLido(c) ? ' unread' : ''}`, ariaCurrent: c.id === store.channelId ? 'page' : null,
      onclick: () => selecionarCanal(c.id),
    }, icone('hash', 18), h('span', { textContent: c.name }), badge(mencoesEm(c.id)))),
    guild && h('div', { className: 'grupo' }, h('span', { textContent: 'Canais de voz' }),
      botaoIcone('mais', 'Criar canal de voz', { tam: 16, onclick: async () => {
        const n = await pedirTexto('Nome do canal de voz'); if (n) await api('POST', `/guilds/${guild.id}/channels`, { name: n, type: 2 });
      } })),
    ...canais.filter((c) => c.type === 2).map(renderCanalVoz),
  );
  renderPainelVoz();
  renderPalco();
  trocar($('#me'), painelMe());
  trocar($('#chanName'), canal && icone('hash', 20), h('span', { textContent: canal?.name ?? '' }));
  // "conectado" não precisa ocupar o cabeçalho: só aparece o que pede atenção (reconectando, erro)
  $('#conn').textContent = store.conn === 'conectado' ? '' : store.conn;
  $('#input').placeholder = canal ? `Mensagem em #${canal.name}` : '';
  $('#reply').hidden = !store.replyTo;
  if (store.replyTo) trocar($('#reply'),
    'Respondendo a ', h('b', { textContent: store.replyTo.author.username }),
    botaoIcone('x', 'Cancelar resposta', { tam: 16, onclick: () => dispatch({ type: 'REPLY_SET', message: null }) }),
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
    h('button', { className: `chan voice${voz.atual()?.channelId === c.id ? ' on' : ''}`, title: 'Entrar no canal de voz', onclick: () => voz.entrar(c) },
      icone('voz', 18), h('span', { textContent: c.name })),
    dentro.map((s) => h('div', {
      className: `vuser${store.speaking.has(s.user_id) ? ' speaking' : ''}`,
      // clicar em outra pessoa abre o volume dela (e o "silenciar só para mim")
      title: s.user_id === store.me.id ? '' : `Volume de ${nome(s.user_id)}`,
      onclick: () => { if (s.user_id !== store.me.id) abrirVolumePessoa(s.user_id); },
    },
      avatar(s.user_id),
      h('span', { className: 'vname', textContent: nome(s.user_id) }),
      s.user_id !== store.me.id && voz.ajustes.volumeDe(s.user_id) !== 1
        && h('small', { className: 'vvol', textContent: `${Math.round(voz.ajustes.volumeDe(s.user_id) * 100)}%` }),
      s.self_stream && h('button', {
        className: 'ao-vivo', textContent: 'AO VIVO', title: `Assistir a tela de ${nome(s.user_id)}`,
        onclick: (e) => { e.stopPropagation(); assistir(s.user_id); },
      }),
      h('span', { className: 'estado' },
        s.self_deaf ? h('span', { title: 'Áudio desativado', role: 'img', ariaLabel: 'Áudio desativado' }, icone('foneOff', 16))
          : s.self_mute && h('span', { title: 'Microfone desligado', role: 'img', ariaLabel: 'Microfone desligado' }, icone('micOff', 16)),
        voz.mutadoLocal(s.user_id) && h('span', { title: 'Silenciado por você', role: 'img', ariaLabel: 'Silenciado por você' }, icone('semSom', 16))),
    )),
  );
}

// ── Servidores (app desktop) ────────────────────────────────────────────────
// A troca acontece aqui mesmo, na janela principal; a janela "Servidor" separada fica para configurar
// a hospedagem. App desktop antigo (sem `servidores` na ponte): cai na janela separada.
const servDlg = $('#servDlg');
async function abrirServidores() {
  const nativo = ponte();
  if (!nativo?.servidores) return nativo?.abrirConexao();
  $('#servErro').textContent = '';
  $('#servConvite').value = '';
  trocar($('#servLista'), h('li', { className: 'nada', textContent: 'Verificando quais estão no ar…' }));
  servDlg.showModal();
  const d = await nativo.servidores();
  const linha = (url, nomeServ, detalhe, online) => {
    const atual = url === d.atual;
    return h('li', { className: `srv${atual ? ' atual' : ''}` },
      h('span', { className: `bola${online ? ' on' : online === false ? ' off' : ''}`, title: online ? 'No ar' : online === false ? 'Fora do ar' : '' }),
      h('span', { className: 'info' }, h('b', { textContent: nomeServ }), h('small', { textContent: detalhe })),
      atual ? h('span', { className: 'tag', textContent: 'ATUAL' })
        : h('button', { type: 'button', className: 'ok', textContent: 'Entrar', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Reiniciando…';
          const r = await nativo.trocarServidor(url);
          if (r?.erro) { $('#servErro').textContent = r.erro; e.target.disabled = false; e.target.textContent = 'Entrar'; }
        } }));
  };
  trocar($('#servLista'),
    linha(null, 'Este computador', 'Hospedar aqui', d.atual === null ? true : undefined),
    ...d.lista.map((s) => linha(s.url, s.nome, s.url, s.online)));
}
$('#servEntrar').addEventListener('click', async (e) => {
  const texto = $('#servConvite').value.trim();
  if (!texto) { $('#servErro').textContent = 'Cole o link de convite que seu amigo mandou.'; $('#servConvite').focus(); return; }
  e.target.disabled = true; $('#servErro').textContent = 'Testando a conexão…';
  const r = await ponte().entrarPorConvite(texto);
  e.target.disabled = false;
  $('#servErro').textContent = r?.erro ?? '';
});
$('#servMais').addEventListener('click', () => { servDlg.close(); ponte()?.abrirConexao(); });

// Hospedando com o Tailscale (ou a publicação pela internet) desligado: faixa no topo, porque quem hospeda
// não percebe que ninguém entra. App desktop antigo não manda internet/publicado: só a parte do Tailscale.
let faixaFunnel = false; // o botão da faixa publica de novo (em vez de ligar o Tailscale)
async function checarHospedagem() {
  const d = await ponte()?.hospedagem?.().catch(() => null);
  const faixa = $('#alertaHost');
  faixaFunnel = !!d?.ligado && !!d.internet && d.publicado === false && !!ponte()?.ligarFunnel;
  faixa.hidden = !d || (d.ligado && !faixaFunnel);
  if (faixa.hidden) return;
  faixa.querySelector('button').textContent = faixaFunnel ? 'Publicar agora' : 'Ligar o Tailscale';
  faixa.querySelector('span').textContent = faixaFunnel
    ? 'Seus amigos não conseguem entrar: a publicação pela internet (Funnel) está desligada.'
    : d.instalado
      ? 'Seus amigos não conseguem entrar: o Tailscale está desligado neste computador.'
      : 'Seus amigos não conseguem entrar: o Tailscale não está instalado neste computador.';
}
$('#alertaHost button').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const r = await (faixaFunnel ? ponte()?.ligarFunnel() : ponte()?.ligarTailscale())?.catch(() => null);
  e.target.disabled = false;
  if (r?.autorizar) $('#alertaHost span').textContent = 'Autorize no navegador: abrimos a página do Tailscale. Clique em Enable e volte aqui.';
  else if (r?.erro) $('#alertaHost span').textContent = r.erro;
  // a autorização pode levar um tempo: confere de novo daqui a pouco (a consulta normal é a cada 20 s)
  setTimeout(checarHospedagem, r?.autorizar ? 10_000 : 2000);
  setTimeout(checarConvite, r?.autorizar ? 10_000 : 2000);
});
if (ponte()?.hospedagem) { checarHospedagem(); setInterval(checarHospedagem, 20_000); }

// ── Convidar amigos (app desktop, hospedando pela internet) ─────────────────
// O link só existe com a publicação no ar; no navegador e em app antigo (sem `convite` na ponte), não aparece.
const convidarDlg = $('#convidarDlg');
let mensagemConvite = '';
const botaoConvidar = botaoIcone('convidar', 'Convidar amigos', { hidden: true, onclick: abrirConvite });
$('#abrirBusca').before(botaoConvidar);
async function checarConvite() {
  const c = await ponte()?.convite?.().catch(() => null);
  botaoConvidar.hidden = !c?.link;
  return c?.link ? c : null;
}
async function abrirConvite() {
  const c = await checarConvite();
  if (!c) return;
  mensagemConvite = c.mensagem || c.link;
  $('#convidarLink').value = c.link;
  $('#convidarStatus').textContent = '';
  $('#convidarStatus').className = 'status';
  convidarDlg.showModal();
  $('#convidarLink').select();
}
$('#convidarCopiar').addEventListener('click', async () => {
  const status = $('#convidarStatus');
  try {
    await navigator.clipboard.writeText(mensagemConvite);
    status.className = 'status ok';
    status.textContent = 'Convite copiado! Cole no WhatsApp ou no Discord do seu amigo.';
  } catch {
    $('#convidarLink').select(); // sem permissão para copiar: deixa o link selecionado para o Ctrl+C
    status.className = 'status erro';
    status.textContent = 'Não consegui copiar sozinho: o link está selecionado, use Ctrl+C.';
  }
});
if (ponte()?.convite) { checarConvite(); setInterval(checarConvite, 20_000); }

// ── Voz e áudio ─────────────────────────────────────────────────────────────
// Ajustes valem na hora (sem "salvar") e ficam guardados neste computador.
const audioDlg = $('#audioDlg'), pessoaDlg = $('#pessoaDlg');
const pct = (x) => `${Math.round(x * 100)}%`;
// Sem permissão de microfone, o navegador esconde os nomes dos dispositivos
let dispositivos = [], versaoDispositivos = 0, permissaoPedida = false, pedindoPermissao = false, erroPermissao = null;
async function preencherDispositivos() {
  const n = ++versaoDispositivos;
  const lista = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => null)) ?? [];
  if (n !== versaoDispositivos) return; // outra leitura mais nova já está a caminho
  const p = voz.ajustes.prefs(), f = audioDlg.querySelector('form');
  dispositivos = lista;
  const opcoes = (tipo, atual, nomeSalvo) => opcoesDispositivos(lista, tipo, atual, nomeSalvo)
    .map((o) => h('option', { value: o.value, textContent: o.nome, selected: o.selected }));
  trocar(f.entrada, opcoes('audioinput', p.entrada, p.entradaNome));
  trocar(f.saida, opcoes('audiooutput', p.saida, p.saidaNome));
  const semNomes = $('#semNomes');
  semNomes.hidden = pedindoPermissao || lista.some((d) => d.label); // com o pedido na tela, ainda não dá para dizer
  semNomes.textContent = !navigator.mediaDevices
    ? 'Este endereço não dá acesso ao microfone: o navegador só libera em https. Use o app desktop do Limb.'
    : erroPermissao === 'NotFoundError' ? 'Nenhum microfone encontrado. Ao conectar um, ele aparece aqui sozinho.'
    : 'Sem permissão para o microfone, os nomes dos aparelhos não aparecem. Libere o microfone para este site (cadeado na barra de endereço) e no Windows (Configurações → Privacidade → Microfone).';
}
async function abrirAjustesAudio() {
  const p = voz.ajustes.prefs(), f = audioDlg.querySelector('form');
  await preencherDispositivos();
  $('#campoSaida').hidden = !voz.ajustes.escolheSaida;
  f.volumeGeral.value = p.volumeGeral;
  $('#volGeralValor').textContent = pct(p.volumeGeral);
  f.qualidadeVoz.value = String(voz.ajustes.qualidadeVoz());
  f.ruido.checked = p.ruido;
  f.eco.checked = p.eco;
  mostrarMicEmUso();
  mostrarSons();
  audioDlg.showModal();
  // sem nomes: pede o microfone uma vez e solta na hora, só para o navegador liberar os nomes
  if (dispositivos.some((d) => d.label) || permissaoPedida || !navigator.mediaDevices?.getUserMedia) return;
  permissaoPedida = pedindoPermissao = true;
  $('#semNomes').hidden = true;
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch (e) { erroPermissao = e.name; } // ocupado também libera os nomes
  pedindoPermissao = false;
  await preencherDispositivos();
}
// Aparelho conectado ou desconectado com a página aberta: atualiza as listas (a escolha fica)
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (audioDlg.open) preencherDispositivos(); });

// "Testar microfone": barra com o volume ao vivo e a marca de onde você aparece falando
let pararTesteMic = null, micDoTeste = null, erroDoTeste = null;
function mostrarMicEmUso() {
  const a = voz.atual(), mic = a ? a.microfone : micDoTeste, erro = a ? a.semMic : erroDoTeste;
  const t = mic ? `Em uso agora: ${mic}` : erro ? `Sem microfone: ${erro}` : '';
  if ($('#micEmUso').textContent !== t) $('#micEmUso').textContent = t;
}
function pararTeste() {
  pararTesteMic?.();
  pararTesteMic = micDoTeste = erroDoTeste = null;
  const barra = $('#micNivel');
  barra.firstElementChild.style.width = '0';
  barra.classList.remove('fala');
  barra.setAttribute('aria-valuenow', '0');
  $('#micTestar').textContent = 'Testar microfone';
  $('#micTestar').classList.remove('ativo');
  $('#micDica').hidden = true;
  mostrarMicEmUso();
}
$('#micTestar').addEventListener('click', () => {
  if (pararTesteMic) return pararTeste();
  const barra = $('#micNivel'), nivel = barra.firstElementChild;
  pararTesteMic = voz.ajustes.testarMicrofone(({ nivel: n, fala, microfone, erro }) => {
    nivel.style.width = `${n}%`;
    barra.classList.toggle('fala', fala);
    const arred = String(Math.round(n));
    if (barra.getAttribute('aria-valuenow') !== arred) barra.setAttribute('aria-valuenow', arred);
    micDoTeste = microfone; erroDoTeste = erro;
    mostrarMicEmUso();
  });
  $('#micTestar').textContent = 'Parar teste';
  $('#micTestar').classList.add('ativo');
  $('#micDica').hidden = false;
});
audioDlg.addEventListener('close', pararTeste); // "Pronto" ou Esc: solta o microfone do teste
$('#micNivel i').style.left = `${voz.ajustes.limiarNivel}%`;
// Sons: guardados à parte ('limb.sons'); sem "Tocar sons", o resto fica desativado
function mostrarSons() {
  const s = sons.config(), f = audioDlg.querySelector('form');
  f.sons.checked = s.ligado;
  $('#sonsOpcoes').disabled = !s.ligado;
  f.sonsVolume.value = s.volume;
  $('#sonsVolValor').textContent = pct(s.volume);
  for (const c of f.querySelectorAll('[data-categoria]')) c.checked = s.categorias[c.dataset.categoria];
}
{
  const f = audioDlg.querySelector('form');
  const nomeDe = (tipo, id) => dispositivos.find((d) => d.kind === tipo && d.deviceId === id)?.label;
  f.entrada.addEventListener('change', () => voz.ajustes.definirEntrada(f.entrada.value, nomeDe('audioinput', f.entrada.value)).then(mostrarMicEmUso));
  f.saida.addEventListener('change', () => voz.ajustes.definirSaida(f.saida.value, nomeDe('audiooutput', f.saida.value)));
  f.volumeGeral.addEventListener('input', () => { voz.ajustes.definirVolumeGeral(f.volumeGeral.value); $('#volGeralValor').textContent = pct(f.volumeGeral.value); });
  f.qualidadeVoz.addEventListener('change', () => voz.ajustes.definirQualidadeVoz(f.qualidadeVoz.value));
  f.ruido.addEventListener('change', () => voz.ajustes.definirProcessamento({ ruido: f.ruido.checked }));
  f.eco.addEventListener('change', () => voz.ajustes.definirProcessamento({ eco: f.eco.checked }));
  f.sons.addEventListener('change', () => { sons.definir({ ligado: f.sons.checked }); mostrarSons(); });
  f.sonsVolume.addEventListener('input', () => { sons.definir({ volume: f.sonsVolume.value }); $('#sonsVolValor').textContent = pct(f.sonsVolume.value); });
  for (const c of f.querySelectorAll('[data-categoria]')) c.addEventListener('change', () => sons.definir({ categorias: { [c.dataset.categoria]: c.checked } }));
  $('#sonsTestar').addEventListener('click', () => sons.testar());
}

let pessoaAtual = null;
function abrirVolumePessoa(userId) {
  pessoaAtual = userId;
  $('#pessoaNome').textContent = nome(userId);
  $('#pessoaVol').value = voz.ajustes.volumeDe(userId);
  $('#pessoaValor').textContent = pct(voz.ajustes.volumeDe(userId));
  $('#pessoaMudo').checked = voz.mutadoLocal(userId);
  pessoaDlg.showModal();
}
$('#pessoaVol').addEventListener('input', (e) => { voz.ajustes.definirVolume(pessoaAtual, e.target.value); $('#pessoaValor').textContent = pct(e.target.value); });
$('#pessoaMudo').addEventListener('change', (e) => { if (e.target.checked !== voz.mutadoLocal(pessoaAtual)) voz.alternarMutoLocal(pessoaAtual); });
$('#pessoaPadrao').addEventListener('click', () => { voz.ajustes.definirVolume(pessoaAtual, 1); $('#pessoaVol').value = 1; $('#pessoaValor').textContent = '100%'; });

// microfone em uso na dica do botão (title com quebra de linha)
const dicaMic = (botao, mic) => { if (mic) botao.title += `\nMicrofone: ${mic}`; return botao; };
function renderPainelVoz() {
  const a = voz.atual();
  // fora do #voice (que é recriado a cada render): o leitor de tela só anuncia o que muda num status que já existe
  const aviso = a?.avisoDispositivo ?? voz.avisoQueda() ?? '';
  if ($('#vozAviso').textContent !== aviso) $('#vozAviso').textContent = aviso;
  if (audioDlg.open) mostrarMicEmUso();
  $('#voice').hidden = !a;
  if (!a) return;
  trocar($('#voice'),
    h('div', { className: 'vstatus' },
      h('b', { className: a.status === 'conectado' ? 'ok' : '', textContent: a.status === 'conectado' ? 'Voz conectada' : 'Conectando…' }),
      h('small', { textContent: `${canalPorId(a.channelId)?.name ?? ''} · ${a.conectados} com áudio` }),
      a.transmitindo && h('small', { className: 'ok', textContent: `Transmitindo · ${a.qualidade}` }),
      // a tela só sai do computador para quem assiste: com ninguém, não gasta internet
      a.transmitindo && h('small', { textContent: assistindoTexto(a.espectadores) || 'Ninguém assistindo ainda' }),
      a.semMic && h('small', { className: 'aviso', role: 'status', title: a.semMic, textContent: `Só ouvindo: ${a.semMic}` }),
      !a.semMic && a.avisoMudo && h('small', { className: 'aviso', role: 'status', textContent: 'Você está mudo' })),
    dicaMic(botaoIcone(a.mute ? 'micOff' : 'mic', a.semMic ? 'Tentar o microfone de novo' : a.mute ? 'Ligar microfone' : 'Desligar microfone',
      { className: a.mute ? 'off' : '', ariaPressed: String(a.mute), onclick: voz.alternarMudo }), a.microfone),
    botaoIcone(a.deaf ? 'foneOff' : 'fone', a.deaf ? 'Ligar áudio' : 'Desligar áudio', { className: a.deaf ? 'off' : '', ariaPressed: String(a.deaf), onclick: voz.alternarSurdo }),
    botaoIcone('tela', a.transmitindo ? 'Parar de compartilhar' : 'Compartilhar tela', {
      className: a.transmitindo ? 'on' : '', ariaPressed: String(a.transmitindo),
      onclick: () => (voz.atual()?.transmitindo ? voz.pararTela() : escolherTela()), // estado na hora do clique
    }),
    botaoIcone('desligar', 'Sair do canal de voz', { className: 'perigo', onclick: voz.sair }),
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
const assistindoTexto = (n) => (n ? `${n} ${n === 1 ? 'pessoa assistindo' : 'pessoas assistindo'}` : '');
const mbps = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`);
function renderPalco() {
  const quem = store.assistindo;
  const ativo = quem && store.voiceStates.get(quem)?.self_stream;
  if (quem && !ativo) store.assistindo = null; // a pessoa parou de transmitir ou saiu
  voz.sincronizarAssistir(); // avisa o servidor (op 101) se mudou quem eu assisto
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
  const taxa = voz.taxaRecebida(quem); // só de quem eu assisto (a prévia não passa pela rede)
  $('#palcoInfo').textContent = [
    cfg?.height && `${cfg.width}×${cfg.height}${cfg.frameRate ? ` · ${Math.round(cfg.frameRate)} fps` : ''}`,
    stream && taxa != null && mbps(taxa),
    assistindoTexto(voz.espectadores(quem)),
  ].filter(Boolean).join(' · ');
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
{
  const f = telaDlg.querySelector('form'), codecs = codecsDeVideo();
  const NOME_CODEC = { H264: 'H.264 (mais leve)', VP9: 'VP9', AV1: 'AV1 (melhor imagem, mais pesado)' };
  trocar(f.resolucao, RESOLUCOES.map((r) => h('option', { value: r, textContent: r === 'original' ? 'Original' : `${r}p` })));
  trocar(f.fps, TAXAS.map((n) => h('option', { value: String(n), textContent: `${n} fps` })));
  trocar(f.codec, h('option', { value: '', textContent: 'Automático' }), codecs.map((c) => h('option', { value: c, textContent: NOME_CODEC[c] })));
  $('#telaAvancado').hidden = !codecs.length; // navegador sem escolha de codec: nada a mostrar
  f.addEventListener('change', estimarTela);
}
// Malha P2P: cada pessoa assistindo recebe uma cópia, direto do seu computador
function estimarTela() {
  const f = telaDlg.querySelector('form'), original = f.resolucao.value === 'original';
  const bps = estimativaTela({ resolucao: f.resolucao.value, fps: f.fps.value });
  $('#telaEstimativa').textContent = `${original ? 'Até' : '≈'} ${mbps(bps)} de upload por pessoa assistindo`;
}
async function escolherTela() {
  const nativo = ponte();
  const form = telaDlg.querySelector('form');
  const ultima = voz.ajustes.tela(); // abre com a última escolha
  for (const k of ['resolucao', 'fps', 'otimizar', 'codec']) form[k].value = String(ultima[k]);
  estimarTela();
  // som do sistema: Windows no app desktop (loopback); no navegador, o Chrome decide (aba/tela)
  $('#telaAudioCampo').hidden = !!nativo && nativo.plataforma !== 'win32';
  $('#telaDica').textContent = nativo
    ? 'Clique na tela ou janela. O som do computador inclui tudo que toca nele, até a voz da chamada: use fone de ouvido.'
    : 'O navegador vai abrir a própria janela de escolha.';
  telaDlg.toggleAttribute('data-desktop', !!nativo);
  trocar($('#telaFontes'));
  const compartilhar = async (fonteId) => {
    const opcoes = { resolucao: form.resolucao.value, fps: Number(form.fps.value), otimizar: form.otimizar.value, codec: form.codec.value,
      comAudio: form.audio.checked && !$('#telaAudioCampo').hidden };
    telaDlg.close();
    try {
      if (fonteId && !(await nativo.escolherFonte(fonteId, opcoes.comAudio))) throw new Error('fonte não está mais disponível');
      await voz.compartilharTela(opcoes);
    } catch (e) {
      if (e.name !== 'NotAllowedError') avisarErro(`Não foi possível compartilhar: ${e.message}`); // NotAllowed = cancelou
    }
  };
  if (nativo) {
    const fontes = await nativo.fontesDeTela();
    trocar($('#telaFontes'), fontes.map((f) => h('button', { type: 'button', className: 'fonte', title: f.nome, onclick: () => compartilhar(f.id) },
      h('img', { src: f.miniatura, alt: '' }), h('span', {}, icone(f.tela ? 'tela' : 'janela', 14), f.nome))));
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
  const ref = m.message_reference && h('div', { className: 'ref' }, icone('responder', 14),
    m.referenced_message
      ? [h('b', { textContent: `@${m.referenced_message.author.username} ` }), markdown(m.referenced_message.content.slice(0, 100))]
      : h('i', { textContent: 'Mensagem original apagada' }));
  return h('div', {
    className: `msg${grupo ? ' cont' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${m.mentions?.includes(store.me.id) ? ' mentioned' : ''}${msgSel === m.id ? ' sel' : ''}`,
    // toque (sem hover): tocar na mensagem mostra as ações; tocar de novo esconde
    onclick: (e) => { if (!e.target.closest('button, a, .spoiler') && real) { msgSel = msgSel === m.id ? null : m.id; agendarRender(); } },
  },
    ref,
    !grupo && avatar(m.author.id, m.author.username),
    !grupo && h('span', { className: 'who', textContent: m.author.username }),
    !grupo && h('span', { className: 'when', title: real ? dataCompleta(m.id) : '', textContent: m.pending ? 'enviando…' : m.failed ? 'não enviada' : hora(m.id) }),
    grupo && real && h('span', { className: 'hh', title: dataCompleta(m.id), textContent: horaCurta(m.id) }),
    h('div', { className: 'body' }, markdown(m.content), m.edited_timestamp && h('span', { className: 'edited', textContent: ' (editado)' })),
    m.reactions?.length > 0 && h('div', { className: 'reactions' }, m.reactions.map((r) => h('button', {
      className: `react${r.me ? ' me' : ''}`, textContent: `${r.emoji} ${r.count}`, disabled: !real, onclick: () => reagir(m, r.emoji),
    }))),
    real && h('div', { className: 'tools', role: 'toolbar', ariaLabel: 'Ações da mensagem' },
      EMOJIS.map((e) => h('button', { type: 'button', textContent: e, title: `Reagir com ${e}`, ariaLabel: `Reagir com ${e}`, onclick: () => reagir(m, e) })),
      h('span', { className: 'div' }),
      h('button', { type: 'button', title: 'Responder', ariaLabel: 'Responder', onclick: () => { msgSel = null; dispatch({ type: 'REPLY_SET', message: m }); $('#input').focus(); } }, icone('responder', 18)),
      meu && h('button', { type: 'button', title: 'Editar', ariaLabel: 'Editar', onclick: async () => {
        const c = await pedirTexto('Editar mensagem', m.content, 2000);
        if (c && c !== m.content) api('PATCH', `/channels/${m.channel_id}/messages/${m.id}`, { content: c }).catch(avisarErro);
      } }, icone('editar', 18)),
      meu && h('button', { type: 'button', className: 'perigo', title: 'Apagar', ariaLabel: 'Apagar', onclick: async () => {
        if (await confirmar('Apagar esta mensagem? Não dá para desfazer.', 'Apagar')) api('DELETE', `/channels/${m.channel_id}/messages/${m.id}`).catch(avisarErro);
      } }, icone('apagar', 18)),
    ),
  );
}

let chaveMensagens = '';
function renderMensagens() {
  const box = $('#messages');
  const ch = store.messages.get(store.channelId);
  // Nada mudou na lista: não reconstrói (a fala na chamada redesenha a tela várias vezes por segundo,
  // e reconstruir também fecharia spoilers abertos e a seleção de texto)
  const chave = [store.channelId, versaoMensagens, msgSel, canalAtual()?.name, ch?.hasMore, store.me?.id].join('|');
  if (chave === chaveMensagens && !grudarNoFim && !manterTopo) return;
  chaveMensagens = chave;
  const noFim = grudarNoFim || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const alturaAntes = box.scrollHeight, topoAntes = box.scrollTop;
  const lista = ch?.list ?? [];
  const canal = canalAtual();
  trocar(box,
    ch?.hasMore && h('button', { className: 'more', textContent: 'Carregar mensagens antigas', onclick: () => {
      grudarNoFim = false; manterTopo = true; carregarMensagens(store.channelId, lista.find((m) => !m.pending)?.id);
    } }),
    // começo do canal: diz onde você está em vez de uma tela vazia
    ch && !ch.hasMore && canal && h('div', { className: 'vazio' },
      h('div', { className: 'marca-ico' }, icone('hash', 28)),
      h('b', { textContent: `Bem-vindo a #${canal.name}` }),
      h('span', { textContent: lista.length ? `Este é o começo do canal #${canal.name}.` : 'Ninguém escreveu aqui ainda. Que tal começar a conversa?' })),
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
  const linha = (u) => h('div', { className: `member${store.online.has(u.id) ? '' : ' off'}` }, avatar(u.id, u.username), h('span', { textContent: u.username }));
  const on = users.filter((u) => store.online.has(u.id)), off = users.filter((u) => !store.online.has(u.id));
  return [h('h4', { textContent: `Online — ${on.length}` }), ...on.map(linha), h('h4', { textContent: `Offline — ${off.length}` }), ...off.map(linha)];
}

function renderBusca() {
  const s = store.search;
  const canalNome = (id) => canalPorId(id)?.name ?? '?';
  const n = s.total ?? 0;
  return [
    h('h4', {}, h('span', { textContent: s.loading && !s.messages.length ? 'Buscando…' : `${n} ${n === 1 ? 'resultado' : 'resultados'}` }),
      botaoIcone('x', 'Fechar busca', { tam: 16, onclick: fecharBusca })),
    !s.loading && n === 0 && h('p', { className: 'nada', textContent: 'Nada encontrado. Tente outra palavra ou outro filtro.' }),
    h('div', { className: 'results' }, s.messages.map((m) => h('button', { type: 'button', className: 'hit', onclick: () => { selecionarCanal(m.channel_id); document.body.classList.remove('membros'); } },
      h('small', { textContent: `#${canalNome(m.channel_id)} · ${m.author.username} · ${hora(m.id)}` }),
      h('div', {}, markdown(m.content)),
    ))),
    s.messages.length < n && h('button', { className: 'mais', textContent: 'Mais resultados', onclick: () => buscar(s.q, s.messages.length).catch(avisarErro) }),
  ];
}
setInterval(() => { if (store.typing.size) renderTyping(); }, 1000);

// ── Eventos da página ───────────────────────────────────────────────────────
let ultimoTyping = 0;
const input = $('#input');
const ajustarAltura = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; };
const botaoEnviar = $('#enviar');
const atualizarEnviar = () => { botaoEnviar.disabled = !input.value.trim(); };
function enviarDoInput() {
  const content = input.value.trim();
  if (!content || !store.channelId) return;
  input.value = '';
  ajustarAltura();
  atualizarEnviar();
  ultimoTyping = 0;
  grudarNoFim = true;
  enviar(content);
}
botaoEnviar.addEventListener('click', () => { enviarDoInput(); input.focus(); });
input.addEventListener('input', () => {
  ajustarAltura();
  atualizarEnviar();
  if (!store.channelId || !input.value.trim() || Date.now() - ultimoTyping < 8000) return;
  ultimoTyping = Date.now();
  api('POST', `/channels/${store.channelId}/typing`).catch(() => {});
});
// Enter envia, Shift+Enter quebra linha; Esc cancela a resposta
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && store.replyTo) dispatch({ type: 'REPLY_SET', message: null });
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  enviarDoInput();
});
function fecharBusca() {
  $('#search').value = '';
  document.body.classList.remove('busca-aberta');
  dispatch({ type: 'SEARCH_CLEAR' });
}
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { fecharBusca(); e.target.blur(); return; }
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  q ? (e.target.blur(), buscar(q).catch(avisarErro)) : fecharBusca();
});
// celular: a busca abre por cima do cabeçalho e fecha ao sair do campo vazio
$('#abrirBusca').addEventListener('click', () => { document.body.classList.add('busca-aberta'); $('#search').focus(); });
$('#search').addEventListener('blur', (e) => { if (!e.target.value.trim()) document.body.classList.remove('busca-aberta'); });
$('#abrirNav').addEventListener('click', () => document.body.classList.toggle('nav'));
$('#abrirMembros').addEventListener('click', () => document.body.classList.toggle('membros'));
$('#veu').addEventListener('click', () => { document.body.classList.remove('nav', 'membros'); if (store.search) fecharBusca(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  document.body.classList.remove('nav', 'membros');
  if (msgSel) { msgSel = null; agendarRender(); }
});
$('#pedir textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#pedir').close('ok'); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.me) ackar(); });

// ── Minha conta ─────────────────────────────────────────────────────────────
// Trocar a senha e ver/derrubar os dispositivos conectados (como "Dispositivos" nas configurações do Discord)
const contaDlg = $('#contaDlg'), senhaForm = $('#senhaForm');
const statusEm = (sel, texto, tipo = '') => { const el = $(sel); el.textContent = texto; el.className = `status ${tipo}`; };
function quandoFoi(ms) {
  const d = new Date(ms), dias = Math.round((diaDe(new Date()) - diaDe(d)) / 86_400_000);
  const hh = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return dias === 0 ? `hoje às ${hh}` : dias === 1 ? `ontem às ${hh}` : `em ${d.toLocaleDateString('pt-BR')}`;
}
function abrirConta() {
  senhaForm.reset();
  senhaForm.username.value = store.me?.username ?? ''; // para o gerenciador de senhas saber de qual conta é
  statusEm('#senhaStatus', '');
  $('#contaCaps').textContent = '';
  $('#contaNome').textContent = store.me?.username ?? '…';
  contaDlg.showModal();
  carregarDispositivos();
}
async function carregarDispositivos() {
  const lista = $('#dispositivos');
  statusEm('#dispStatus', '');
  trocar(lista, h('li', { className: 'nada', textContent: 'Carregando…' }));
  let sessoes;
  try { sessoes = await api('GET', '/users/@me/sessions'); } catch (e) {
    trocar(lista);
    statusEm('#dispStatus', `Não foi possível carregar os dispositivos: ${e.message}`, 'erro');
    return;
  }
  $('#sairOutros').disabled = sessoes.length < 2;
  sessoes.sort((a, b) => b.atual - a.atual); // este dispositivo primeiro; os outros, do uso mais recente
  trocar(lista, sessoes.map((s) => {
    const nomeDisp = s.dispositivo || 'Dispositivo desconhecido';
    return h('li', { className: `srv${s.atual ? ' atual' : ''}` },
      h('span', { className: 'info' },
        h('b', { textContent: nomeDisp }),
        h('small', { textContent: s.atual ? `Conectado desde ${quandoFoi(s.criado)}` : `Último uso ${quandoFoi(s.usado)}` })),
      s.atual ? h('span', { className: 'tag', textContent: 'ESTE DISPOSITIVO' })
        : h('button', { type: 'button', className: 'desconectar', textContent: 'Desconectar', ariaLabel: `Desconectar ${nomeDisp} (último uso ${quandoFoi(s.usado)})`,
          onclick: (e) => desconectar(e.currentTarget, s.id) }));
  }));
}
async function desconectar(botao, id) {
  botao.disabled = true;
  try {
    await api('DELETE', `/users/@me/sessions/${id}`);
    await carregarDispositivos();
    $('#dispTitulo').focus(); // o botão clicado sumiu com a lista: o foco não cai no nada
    statusEm('#dispStatus', 'Dispositivo desconectado.', 'ok');
  } catch (e) { botao.disabled = false; statusEm('#dispStatus', e.message, 'erro'); }
}
$('#sairConta').addEventListener('click', sair);
$('#sairOutros').addEventListener('click', async (e) => {
  const botao = e.currentTarget;
  if (!(await confirmar('Desconectar todos os outros dispositivos? Eles vão precisar entrar de novo.', 'Desconectar'))) return;
  botao.disabled = true;
  try {
    await api('POST', '/users/@me/sessions/encerrar-outras');
    await carregarDispositivos();
    $('#dispTitulo').focus();
    statusEm('#dispStatus', 'Os outros dispositivos foram desconectados.', 'ok');
  } catch (err) { botao.disabled = false; statusEm('#dispStatus', err.message, 'erro'); }
});
senhaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = senhaForm, botao = $('#senhaBotao');
  if (f.nova.value !== f.confirmar.value) { statusEm('#senhaStatus', 'A nova senha e a confirmação não são iguais.', 'erro'); f.confirmar.focus(); return; }
  botao.disabled = true;
  statusEm('#senhaStatus', 'Alterando a senha…');
  try {
    await api('POST', '/users/@me/password', { senha_atual: f.atual.value, senha_nova: f.nova.value });
    f.atual.value = f.nova.value = f.confirmar.value = '';
    statusEm('#senhaStatus', 'Senha alterada. Os outros dispositivos foram desconectados.', 'ok');
    carregarDispositivos();
  } catch (err) { statusEm('#senhaStatus', err.message, 'erro'); }
  finally { botao.disabled = false; }
});

// Caps Lock ligado num campo de senha: avisa (o erro mais comum de "senha incorreta")
function avisarCaps(campos, aviso) {
  const ver = (e) => { aviso.textContent = e.getModifierState?.('CapsLock') ? 'Caps Lock está ativado.' : ''; };
  for (const c of campos) {
    c.addEventListener('keydown', ver);
    c.addEventListener('keyup', ver);
    c.addEventListener('blur', () => { aviso.textContent = ''; });
  }
}
avisarCaps([senhaForm.atual, senhaForm.nova, senhaForm.confirmar], $('#contaCaps'));

// ── Sessão ──────────────────────────────────────────────────────────────────
// localStorage pode não existir (bloqueado, modo privado): sem ele, só não lembra; vazio apaga
const guardado = (chave) => ({
  get: () => { try { return localStorage.getItem(chave) ?? ''; } catch { return ''; } },
  set: (v) => { try { v ? localStorage.setItem(chave, v) : localStorage.removeItem(chave); } catch {} },
});
const salvo = guardado('token');
// Já entrou neste servidor alguma vez? Convite abre em "Criar conta" só para quem nunca entrou
const jaEntrou = guardado('jaEntrou');

const loginForm = $('#login form');
function entrar(token) {
  store.token = token;
  salvo.set(token);
  jaEntrou.set('1');
  loginForm.password.value = loginForm.confirmar.value = '';
  mostrarSenha(false);
  $('#loginAviso').textContent = '';
  $('#login').hidden = true;
  $('#app').hidden = false;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  gateway.connect();
}
// Fecha tudo neste aparelho (voz, gateway, token salvo) e volta para a tela de entrar
function encerrarLocal() {
  voz.sair();
  gateway.close();
  salvo.set(null);
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  Object.assign(store, { token: null, me: null, guildId: null, channelId: null, search: null, replyTo: null });
  store.messages.clear();
  $('#app').hidden = true;
  $('#login').hidden = false;
  document.body.classList.remove('nav', 'membros', 'busca-aberta');
  definirModo('entrar');
  lerInfo(); // o servidor pode ter ganhado contas (ou trocado de convite) desde que a página abriu
}
// "Sair da conta": o servidor revoga o token deste aparelho. fetch direto, não api(): api() chama
// sessaoTerminou() no 401, e sair não depende da resposta (sem rede, ao menos esquece o token aqui)
function sair() {
  const token = store.token;
  encerrarLocal();
  if (token) fetch('/api/logout', { method: 'POST', headers: { Authorization: token }, keepalive: true }).catch(() => {});
}
// Token revogado (senha trocada, "Desconectar" em outro aparelho) ou vencido: REST 401 ou gateway 4004
function sessaoTerminou() {
  if (voz.atual()) sons.tocar('desconectado'); // a chamada caiu junto com a sessão: não foi escolha minha
  voz.resetar(); // sem op 4: a sessão já morreu no servidor (e o voz.sair() abaixo fica sem o som de 'sair')
  encerrarLocal();
  $('#loginAviso').textContent = 'Sua sessão terminou. Entre de novo.';
}

// Tela de entrar: "Entrar" (conta existente) ou "Criar conta", como no Discord
let modoLogin = 'entrar', conviteNoServidor = false, nomeServidor = '', colarAberto = false, primeiraConta = false, semDono = false;
// Servidor sem contas aberto de fora (quem hospeda testando o próprio link .ts.net): diz onde criar a conta do dono
const semConviteAviso = () => (semDono
  ? 'Servidor novo: crie a primeira conta no app do Limb de quem hospeda, ou abra o link de convite (Servidor → Copiar convite).'
  : 'Este servidor só aceita convidados. Peça o link de convite para quem hospeda.');

// Como no Discord, o link é o convite: o código vem escondido nele (/#convite=<código>) e ninguém vê nem
// digita. Fica guardado neste navegador (o localStorage já é separado por servidor) para sobreviver a
// recarregar a página ou trocar entre Entrar e Criar conta.
const conviteSalvo = guardado('convite');
let convite = conviteSalvo.get();
const guardarConvite = (c) => { convite = c; conviteSalvo.set(c); };
// O último convite que o servidor recusou: o app desktop recoloca o #convite= do link antigo a cada abertura,
// e ele não pode apagar um link novo que a pessoa colou aqui
const conviteRecusado = guardado('conviteRecusado');
// Link colado: …/convite/<código>, …/#convite=<código>, limb://entrar?…&convite=<código> ou a mensagem inteira
// do convite; em último caso, o código sozinho. null = não achei convite nenhum.
function lerLinkConvite(texto) {
  const t = String(texto ?? '').trim().slice(0, 2000);
  const decodificar = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
  // parênteses fora, como no lerConvite do app: na mensagem do convite, o link vem antes de "(Abre no navegador…)"
  const m = /\/convite\/([^\s/?#<>"'()]+)/i.exec(t) ?? /[#?&]convite=([^\s&#<>"'()]+)/i.exec(t);
  // "…/convite/abc." no fim da frase, ou com o negrito do WhatsApp: a pontuação não faz parte do código
  const c = m ? decodificar(m[1].replace(/[.,;:!?*_~]+$/, '')) : /^[^\s/:]{1,100}$/.test(t) ? t : null;
  return conviteValido(c);
}
function conviteValido(c) {
  const v = typeof c === 'string' ? c.trim() : '';
  return v && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}
// Com convite: "✓ Você foi convidado para …". Sem, num servidor que pede: o aviso e o "Tenho um link de convite"
// (que abre o campo para colar). Entrar numa conta que já existe não pede convite.
function mostrarConvite() {
  const criar = modoLogin === 'criar', precisa = criar && conviteNoServidor;
  // servidor sem contas: a primeira é a do dono e não precisa de convite
  const dono = criar && primeiraConta;
  $('#conviteOk').hidden = !dono && (!convite || !criar);
  if (dono) trocar($('#conviteOk'), 'Este servidor ainda não tem contas: a primeira é a sua, de dono.');
  else trocar($('#conviteOk'), '✓ Você foi convidado para ', h('b', { textContent: nomeServidor || 'este servidor' }));
  $('#semConvite').hidden = !!convite || !precisa;
  $('#semConviteTexto').textContent = semConviteAviso();
  $('#tenhoLink').hidden = colarAberto;
  $('#colarCampo').hidden = !colarAberto;
  // sem convite, criar conta só daria erro: o botão volta quando o convite chegar
  $('#loginBotao').hidden = precisa && !convite;
}
$('#tenhoLink').addEventListener('click', () => { colarAberto = true; mostrarConvite(); $('#colarConvite').focus(); });
function usarColado(colado) {
  const campo = $('#colarConvite'), texto = (colado ?? campo.value).trim();
  if (!texto) { $('#colarErro').textContent = ''; return; }
  const c = lerLinkConvite(texto);
  if (!c) { $('#colarErro').textContent = 'Não achei um convite aí. Cole o link inteiro que mandaram para você.'; return; }
  guardarConvite(c);
  colarAberto = false;
  campo.value = '';
  $('#colarErro').textContent = '';
  $('#loginErro').textContent = '';
  mostrarConvite();
  // o campo sumiu: o foco vai para o próximo passo, e não para o nada
  (modoLogin === 'criar' && !loginForm.username.value ? loginForm.username : $('#loginBotao')).focus();
}
// Colou: confere na hora, com o texto da área de transferência (o campo de uma linha só junta as linhas da
// mensagem: "…/convite/abc" + "(Abre no navegador…)"). Digitando à mão (o código sozinho), só no Enter ou ao sair.
$('#colarConvite').addEventListener('paste', (e) => {
  const texto = e.clipboardData?.getData('text');
  if (!texto) return; // sem acesso ao texto: o 'input' abaixo confere o que entrou no campo
  e.preventDefault();
  $('#colarConvite').value = texto.replace(/\s+/g, ' ').trim().slice(0, 2000); // se não achar, a pessoa vê o que colou
  usarColado(texto);
});
$('#colarConvite').addEventListener('input', (e) => {
  if (/^insertFrom(Paste|Drop)/.test(e.inputType ?? '')) usarColado();
  else $('#colarErro').textContent = '';
});
$('#colarConvite').addEventListener('change', () => usarColado());
$('#colarConvite').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); usarColado(); } });
function definirModo(modo) {
  modoLogin = modo;
  const criar = modo === 'criar', f = loginForm;
  $('#loginTitulo').textContent = criar ? 'Criar conta' : 'Entrar';
  $('#loginDica').textContent = criar ? 'Escolha um nome de usuário e uma senha. A conta fica neste servidor.' : 'Que bom te ver de novo!';
  $('#loginBotao').textContent = criar ? 'Criar conta' : 'Entrar';
  $('#trocaTexto').textContent = criar ? 'Já tem uma conta?' : 'Precisa de uma conta?';
  $('#trocaModo').textContent = criar ? 'Entrar' : 'Registre-se';
  f.password.autocomplete = criar ? 'new-password' : 'current-password';
  f.password.setAttribute('aria-describedby', criar ? 'regrasSenha capsAviso' : 'capsAviso');
  $('#confirmarCampo').hidden = !criar;
  f.confirmar.disabled = !criar; // desabilitado não trava o envio por "required" escondido
  f.confirmar.required = criar;
  $('#regrasSenha').hidden = !criar;
  mostrarConvite();
  $('#loginErro').textContent = '';
  atualizarRegras();
}
// Regras da senha nova ao vivo (a lista de senhas comuns fica só no servidor)
function atualizarRegras() {
  const senha = loginForm.password.value, nomeUsuario = loginForm.username.value.trim().toLowerCase();
  $('#regraTamanho').classList.toggle('ok', senha.length >= 8 && senha.length <= 128);
  $('#regraNome').classList.toggle('ok', !!senha && !(nomeUsuario.length >= 3 && senha.toLowerCase().includes(nomeUsuario)));
}
function mostrarSenha(ver) {
  $('#mostrarSenha').setAttribute('aria-pressed', String(ver));
  for (const c of [loginForm.password, loginForm.confirmar]) c.type = ver ? 'text' : 'password';
}
$('#mostrarSenha').addEventListener('click', (e) => mostrarSenha(e.currentTarget.getAttribute('aria-pressed') !== 'true'));
loginForm.password.addEventListener('input', atualizarRegras);
loginForm.username.addEventListener('input', atualizarRegras);
avisarCaps([loginForm.password, loginForm.confirmar], $('#capsAviso'));
$('#trocaModo').addEventListener('click', () => { definirModo(modoLogin === 'criar' ? 'entrar' : 'criar'); loginForm.username.focus(); });
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = loginForm, erro = $('#loginErro'), botao = $('#loginBotao'), criar = modoLogin === 'criar';
  erro.textContent = '';
  if (criar && f.password.value !== f.confirmar.value) { erro.textContent = 'As senhas não são iguais.'; f.confirmar.focus(); return; }
  // Enter num campo com o botão escondido (servidor só de convidados, sem convite): nem tenta
  if (botao.hidden) { erro.textContent = semConviteAviso(); return; }
  botao.disabled = true;
  botao.textContent = criar ? 'Criando conta…' : 'Entrando…';
  const enviado = criar ? convite : ''; // o convite só serve para criar conta
  try {
    // fetch direto: o 401 de senha errada não é sessão terminada
    const r = await fetch(`/api/${criar ? 'register' : 'login'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.username.value, password: f.password.value, invite: enviado || undefined }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (d.convite) { // criar conta pediu convite
        primeiraConta = false; // o servidor já tem dono
        conviteNoServidor = true;
        // convite recusado: o guardado não vale mais (link antigo, "Gerar link novo"); volta o jeito de colar outro
        if (enviado) { conviteRecusado.set(enviado); if (enviado === convite) guardarConvite(''); }
        mostrarConvite();
        if (!$('#tenhoLink').hidden) $('#tenhoLink').focus();
        if (enviado) throw new Error('Este convite não vale mais. Peça um link novo para quem hospeda.');
      }
      throw new Error(d.message || `Erro ${r.status}`);
    }
    if (convite) guardarConvite(''); // já tem conta: não fica guardado à toa
    primeiraConta = semDono = false;
    entrar(d.token);
  } catch (err) {
    erro.textContent = err instanceof TypeError ? 'Não foi possível falar com o servidor. Confira a conexão e tente de novo.' : err.message;
  } finally {
    botao.disabled = false;
    botao.textContent = modoLogin === 'criar' ? 'Criar conta' : 'Entrar';
  }
});
// Diz onde a conta vai ser criada: no app desktop, o servidor embutido é "este computador"
$('#ondeServidor').textContent = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? 'este computador' : location.host;
// O convite chega como #convite=… (o "Entrar pelo navegador" da página de convite, o app desktop do amigo e o
// de quem hospeda): guarda e tira do endereço
const conviteUrl = /[#&]convite=([^&]+)/.exec(location.hash)?.[1];
if (conviteUrl) {
  let c = null;
  try { c = conviteValido(decodeURIComponent(conviteUrl)); } catch { /* %E0%A4 cortado: ignora */ }
  // o link antigo que o servidor já recusou não apaga um novo que a pessoa colou
  if (c && c !== conviteRecusado.get()) guardarConvite(c);
  history.replaceState(null, '', location.pathname + location.search);
}
// Quem chegou por convite (agora ou antes de recarregar: ele fica guardado) e nunca entrou aqui quer criar
// conta; o resto, entrar
definirModo((conviteUrl || convite) && !jaEntrou.get() ? 'criar' : 'entrar');
// Se o servidor só aceita convidados, se ainda não tem contas, e o nome dele para o "✓ Você foi convidado para …".
// Lido ao abrir e de novo a cada volta para a tela de entrar (a página não recarrega ao sair da conta).
function lerInfo(abrindo = false) {
  fetch('/api/info').then((r) => r.json()).then((i) => {
    conviteNoServidor = !!i.convite;
    primeiraConta = i.primeiraConta === true;
    semDono = i.semDono === true;
    nomeServidor = typeof i.nome === 'string' ? i.nome.slice(0, 60) : '';
    if (abrindo && primeiraConta && !salvo.get()) definirModo('criar'); // servidor novo: o dono chega para criar a conta
    mostrarConvite();
  }).catch(() => {});
}
lerInfo(true);
// App desktop: trocar de servidor (hospedar aqui ou entrar no de um amigo)
if (ponte()?.abrirConexao) {
  $('#trocarServidor').hidden = false;
  $('#trocarServidor').addEventListener('click', abrirServidores);
}
salvo.get() ? entrar(salvo.get()) : ($('#login').hidden = false);
