// ETF (Erlang External Term Format): port em JS do discord_erlpack.node, reconstruído
// a partir da descompilação no Ghidra (ver EVIDENCIAS.md, seção 9). Roda no Node e no navegador.
//
// pack:   null/undefined → atom nil · boolean → atom true/false · inteiro 0..255 → SMALL_INTEGER
//         int32 → INTEGER · inteiro maior / BigInt → SMALL_BIG · fracionário → NEW_FLOAT
//         string → BINARY (UTF-8) · array → LIST + NIL · objeto → MAP
// unpack: atom nil/null → null · true/false → boolean · outros atoms → string · BINARY → string
//         big int ≥ 2^31 (até 8 bytes) → string decimal (é assim que snowflakes viram string)
//         NIL → [] · tuplas → array · STRING_EXT → array de bytes

const VERSION = 131;
const MAX_DEPTH = 256; // FUN_180001220(..., 0x100)
const T = {
  NEW_FLOAT: 70, SMALL_INTEGER: 97, INTEGER: 98, FLOAT: 99, ATOM: 100, SMALL_TUPLE: 104, LARGE_TUPLE: 105,
  NIL: 106, STRING: 107, LIST: 108, BINARY: 109, SMALL_BIG: 110, LARGE_BIG: 111, SMALL_ATOM: 115, MAP: 116,
};
const enc = new TextEncoder();
const dec = new TextDecoder();

export function pack(value) {
  let buf = new Uint8Array(1024), view = new DataView(buf.buffer), pos = 0;
  const need = (n) => {
    if (pos + n <= buf.length) return;
    const novo = new Uint8Array(Math.max(buf.length * 2, pos + n));
    novo.set(buf);
    buf = novo; view = new DataView(buf.buffer);
  };
  const u8 = (v) => { need(1); buf[pos++] = v; };
  const u32 = (v) => { need(4); view.setUint32(pos, v); pos += 4; };
  const bytes = (b) => { need(b.length); buf.set(b, pos); pos += b.length; };
  const atom = (s) => { u8(T.SMALL_ATOM); u8(s.length); bytes(enc.encode(s)); };
  const big = (n) => { // SMALL_BIG: n bytes little-endian + sinal
    const neg = n < 0n; let m = neg ? -n : n;
    const ds = [];
    while (m > 0n) { ds.push(Number(m & 0xffn)); m >>= 8n; }
    if (ds.length > 255) throw new Error('Unable to encode this type');
    u8(T.SMALL_BIG); u8(ds.length); u8(neg ? 1 : 0); bytes(ds);
  };

  function term(v, depth) {
    if (depth < 0) throw new Error('Reached recursion limit');
    if (v === null || v === undefined) return atom('nil');
    switch (typeof v) {
      case 'boolean': return atom(v ? 'true' : 'false');
      case 'bigint': return big(v);
      case 'string': { const b = enc.encode(v); u8(T.BINARY); u32(b.length); return bytes(b); }
      case 'number':
        // ponytail: nativo converte negativo > int32 errado (sinal sempre 0); aqui grava o sinal
        if (!Number.isInteger(v) || Math.abs(v) >= 2 ** 64) { need(9); buf[pos++] = T.NEW_FLOAT; view.setFloat64(pos, v); pos += 8; return; }
        if (v >= 0 && v < 256) { u8(T.SMALL_INTEGER); return u8(v); }
        if (v >= -(2 ** 31) && v < 2 ** 31) { u8(T.INTEGER); need(4); view.setInt32(pos, v); pos += 4; return; }
        return big(BigInt(v));
      case 'object':
        // Array vazio → só NIL (6a), confirmado rodando o nativo
        if (Array.isArray(v)) {
          if (v.length) { u8(T.LIST); u32(v.length); for (const x of v) term(x, depth - 1); }
          return u8(T.NIL);
        }
        if (v instanceof Uint8Array) { u8(T.BINARY); u32(v.length); return bytes(v); }
        {
          const ks = Object.keys(v);
          u8(T.MAP); u32(ks.length);
          for (const k of ks) { term(k, depth - 1); term(v[k], depth - 1); }
          return;
        }
      default: throw new Error('Unable to encode this type');
    }
  }

  u8(VERSION);
  term(value, MAX_DEPTH);
  return buf.slice(0, pos);
}

export function unpack(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const fim = (n) => { if (pos + n > buf.length) throw new Error('Unpacking beyond the end of the buffer'); };
  const u8 = () => { fim(1); return buf[pos++]; };
  const u16 = () => { fim(2); const v = view.getUint16(pos); pos += 2; return v; };
  const u32 = () => { fim(4); const v = view.getUint32(pos); pos += 4; return v; };
  const slice = (n) => { fim(n); return buf.subarray(pos, (pos += n)); };
  const latin1 = (b) => String.fromCharCode(...b);

  function atom(s) {
    if (s === 'nil' || s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    return s;
  }
  function big(n) {
    if (n > 8) throw new Error('Unable to decode big ints larger than 8 bytes');
    const neg = u8() === 1;
    let v = 0n;
    const ds = slice(n);
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(ds[i]);
    // ≤ 4 bytes: positivo → número (uint32); negativo só se couber em int32. Resto → string.
    if (n <= 4 && (!neg || v < 2n ** 31n)) return neg ? -Number(v) : Number(v);
    return (neg ? '-' : '') + v.toString();
  }
  // n vem do próprio buffer: cada termo ocupa ≥ 1 byte, então n > bytes restantes é mentira
  const lista = (n, d) => { fim(n); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = term(d); return a; };

  function term(depth = MAX_DEPTH) {
    if (depth < 0) throw new Error('Reached recursion limit'); // entrada hostil não estoura a pilha
    const d = depth - 1;
    const tag = u8();
    switch (tag) {
      case T.SMALL_INTEGER: return u8();
      case T.INTEGER: { fim(4); const v = view.getInt32(pos); pos += 4; return v; }
      case T.NEW_FLOAT: { fim(8); const v = view.getFloat64(pos); pos += 8; return v; }
      case T.FLOAT: {
        const v = Number.parseFloat(latin1(slice(31)).replace(/\0+$/, ''));
        if (Number.isNaN(v)) throw new Error('Invalid float encoded.');
        return v;
      }
      case T.ATOM: return atom(latin1(slice(u16())));
      case T.SMALL_ATOM: return atom(latin1(slice(u8())));
      case T.SMALL_TUPLE: return lista(u8(), d);
      case T.LARGE_TUPLE: return lista(u32(), d);
      case T.NIL: return [];
      case T.STRING: return Array.from(slice(u16()));
      case T.LIST: {
        const a = lista(u32(), d);
        if (u8() !== T.NIL) throw new Error("List doesn't end with a tail marker, but it must!");
        return a;
      }
      case T.BINARY: return dec.decode(slice(u32()));
      case T.SMALL_BIG: return big(u8());
      case T.LARGE_BIG: return big(u32());
      case T.MAP: {
        const o = {};
        // defineProperty: chave "__proto__" vira propriedade comum, não troca o protótipo
        for (let n = u32(); n > 0; n--) {
          const k = String(term(d));
          Object.defineProperty(o, k, { value: term(d), enumerable: true, writable: true, configurable: true });
        }
        return o;
      }
      // ponytail: COMPRESSED(80), REFERENCE, PORT, PID, EXPORT existem no nativo mas não trafegam neste app
      default: throw new Error('Unsupported erlang term type identifier found');
    }
  }

  if (u8() !== VERSION) throw new Error('Bad version number.');
  return term();
}
