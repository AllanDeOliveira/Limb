// Snowflake e busca no estilo do Discord (formato de id e filtros iguais aos da API dele).

// ── Snowflake ───────────────────────────────────────────────────────────────
// Discord: DISCORD_EPOCH=14200704e5; fromTimestamp(t) = (t - epoch) << 22;
// extractTimestamp(id) = floor(id / 4194304) + epoch. O id carrega a data.
export const EPOCH = 1420070400000n;
let last = 0n, seq = 0n;

export function snowflake(ms = Date.now()) {
  let t = BigInt(ms);
  if (t < last) t = last; // relógio voltou: nunca repete id
  if (t === last) {
    seq = (seq + 1n) & 4095n;
    if (seq === 0n) t = last + 1n; // 4096 ids no mesmo ms: empresta o próximo ms
  } else seq = 0n;
  last = t;
  return ((t - EPOCH) << 22n) | seq; // ponytail: worker/processo = 0, um servidor só
}
export const fromTimestamp = (ms) => (BigInt(ms) - EPOCH) << 22n;
export const timestampOf = (id) => Number((BigInt(id) >> 22n) + EPOCH);

// ── Busca ───────────────────────────────────────────────────────────────────
// Discord: filtro = RegExp(`${nome}:`, "i"); valores do mesmo filtro vão para
// um Set (OU); "-" nega; before/during/after viram min_id/max_id (snowflake);
// o que sobra vira `content`.
const TOKEN = /(-?)([a-z]+):(?:"((?:\\.|[^"\\])*)"|(\S+))|"((?:\\.|[^"\\])*)"|(\S+)/gi;
const unescape = (s) => s.replace(/\\(.)/g, '$1');
const FILTROS = {
  // nomes de usuário e canal são gravados em minúsculas (server.js)
  from: (v) => ['m.author_id IN (SELECT id FROM users WHERE name = ?)', [v.replace(/^@/, '').toLowerCase()]],
  // m.mentions = JSON com ids de quem foi mencionado de fato (usuário existente)
  mentions: (v) => ['EXISTS (SELECT 1 FROM json_each(m.mentions) j JOIN users u ON j.value = CAST(u.id AS TEXT) WHERE u.name = ?)',
    [v.replace(/^@/, '').toLowerCase()]],
  in: (v) => ['m.channel_id IN (SELECT id FROM channels WHERE name = ?)', [v.replace(/^#/, '').toLowerCase()]],
  has: (v) => HAS[v.toLowerCase()],
};
const HAS = {
  link: ["(m.content LIKE '%http://%' OR m.content LIKE '%https://%')", []],
  mention: ["m.mentions != '[]'", []],
};
const DATAS = new Set(['before', 'during', 'after']);
const like = (s) => s.replace(/[\\%_]/g, '\\$&');

// YYYY-MM-DD → início do dia local (ms) ou null
function dia(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}
const proxDia = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); };

export function parseSearch(q) {
  const filtros = {}; // nome → { sim: [], nao: [] }
  const texto = [];
  let min = null, max = null;
  for (const m of String(q ?? '').matchAll(TOKEN)) {
    const [bruto, neg, nomeRaw, aspas, solto, frase] = m;
    const nome = nomeRaw?.toLowerCase();
    const valor = nome ? unescape(aspas ?? solto) : null;
    if (nome && DATAS.has(nome) && dia(valor) != null) {
      const d = dia(valor);
      if (nome === 'before') max = d;
      if (nome === 'after') min = proxDia(d);
      if (nome === 'during') { min = d; max = proxDia(d); }
      continue;
    }
    if (nome && FILTROS[nome]?.(valor)) { // has:xyz desconhecido cai para texto, como o validator do Discord
      (filtros[nome] ??= { sim: [], nao: [] })[neg ? 'nao' : 'sim'].push(valor);
      continue;
    }
    texto.push(frase != null ? unescape(frase) : bruto);
  }
  return {
    filtros, texto,
    min_id: min == null ? null : fromTimestamp(min),
    max_id: max == null ? null : fromTimestamp(max),
  };
}

// parseSearch → { sql, params } (sempre parametrizado; nomes de filtro vêm da whitelist)
export function searchToSql({ filtros, texto, min_id, max_id }) {
  const sql = [], params = [];
  const add = ([s, p], neg) => { sql.push(neg ? `NOT (${s})` : `(${s})`); params.push(...p); };
  for (const [nome, { sim, nao }] of Object.entries(filtros)) {
    if (sim.length) {
      const partes = sim.map((v) => FILTROS[nome](v));
      add([partes.map(([s]) => `(${s})`).join(' OR '), partes.flatMap(([, p]) => p)]);
    }
    for (const v of nao) add(FILTROS[nome](v), true);
  }
  for (const t of texto) add(["m.content LIKE ? ESCAPE '\\'", [`%${like(t)}%`]]);
  if (min_id != null) add(['m.id >= ?', [min_id]]);
  if (max_id != null) add(['m.id < ?', [max_id]]);
  return { sql: sql.join(' AND ') || '1', params };
}
