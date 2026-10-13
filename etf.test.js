import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pack, unpack } from './public/etf.js';

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));

test('pack: bytes iguais aos gerados pelo nativo (descompilação)', () => {
  assert.equal(hex(pack(null)), '8373036e696c');           // atom nil
  assert.equal(hex(pack(true)), '83730474727565');
  assert.equal(hex(pack(false)), '837305' + '66616c7365');
  assert.equal(hex(pack(5)), '836105');                    // SMALL_INTEGER
  assert.equal(hex(pack(-1)), '8362ffffffff');             // INTEGER
  assert.equal(hex(pack(2 ** 40)), '836e0600' + '000000000001'); // SMALL_BIG LE, sinal 0
  assert.equal(hex(pack(1.5)), '83463ff8000000000000');    // NEW_FLOAT big-endian
  assert.equal(hex(pack('oi')), '836d000000026f69');       // BINARY
  assert.equal(hex(pack([1, 'a'])), '836c0000000261016d00000001616a'); // LIST + NIL
  assert.equal(hex(pack([])), '836a');
  assert.equal(hex(pack({ a: 1 })), '8374000000016d00000001616101');  // MAP
});

test('unpack: regras do decoder nativo', () => {
  assert.equal(unpack(bytes('836e0800' + 'ffffffffffffff0f')), '1152921504606846975'); // snowflake → string
  assert.equal(unpack(bytes('836e040000000080')), 2147483648);    // 4 bytes positivo → número (uint32)
  assert.equal(unpack(bytes('836e040100000080')), '-2147483648'); // 4 bytes negativo fora de int32 → string
  assert.equal(unpack(bytes('836e0401ffffff7f')), -2147483647);  // negativo que cabe → número
  assert.equal(unpack(bytes('83640004' + Buffer.from('null').toString('hex'))), null);
  assert.equal(unpack(bytes('8373' + '05' + Buffer.from('outro').toString('hex'))), 'outro');
  assert.deepEqual(unpack(bytes('836b0003010203')), [1, 2, 3]);  // STRING_EXT → bytes
  assert.deepEqual(unpack(bytes('83680261016102')), [1, 2]);     // tupla → array
  assert.throws(() => unpack(bytes('8261')), /Bad version number/);
  assert.throws(() => unpack(bytes('836c000000016101')), /beyond the end/);
  assert.throws(() => unpack(bytes('836c00000001610161')), /tail marker/);
  assert.throws(() => unpack(bytes('836e09' + '00'.repeat(10))), /larger than 8 bytes/);
  assert.throws(() => unpack(bytes('8301')), /Unsupported erlang term/);
  assert.throws(() => unpack(bytes('83' + '6c00000001'.repeat(300))), /recursion limit/);
  assert.throws(() => unpack(bytes('836cffffffff')), /beyond the end/); // tamanho mentiroso não aloca 4 bi
  const o = unpack(pack({ ['__proto__']: { x: 1 } }));
  assert.equal(Object.getPrototypeOf(o), Object.prototype); // protótipo não foi trocado
  assert.deepEqual(Object.keys(o), ['__proto__']);
});

test('round-trip de um payload do gateway, com snowflake BigInt', () => {
  const p = { op: 0, t: 'MESSAGE_CREATE', s: 42, d: { id: 1234567890123456789n, content: 'olá 🎉', mentions: [], ok: true, x: null, f: 0.1 } };
  assert.deepEqual(unpack(pack(p)), { ...p, d: { ...p.d, id: '1234567890123456789' } });
});

// ── Diferencial contra o discord_erlpack.node instalado ───────────────────────
function acharNativo() {
  if (process.env.ERLPACK_NODE) return process.env.ERLPACK_NODE;
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'Discord');
  if (!existsSync(base)) return null;
  for (const app of readdirSync(base).filter((d) => d.startsWith('app-')).sort().reverse()) {
    const mods = path.join(base, app, 'modules');
    if (!existsSync(mods)) continue;
    for (const m of readdirSync(mods).filter((d) => d.startsWith('discord_erlpack'))) {
      const f = path.join(mods, m, 'discord_erlpack', 'discord_erlpack.node');
      if (existsSync(f)) return f;
    }
  }
  return null;
}
const nativo = acharNativo();

// O nativo mantém um handle do libuv vivo: roda num processo filho que sai sozinho
function noNativo(casos, entradas) {
  const script = `const m={exports:{}};process.dlopen(m,process.argv[1]);const e=m.exports;
    const {casos,entradas}=JSON.parse(process.argv[2]);
    const out={pack:casos.map(v=>Buffer.from(e.pack(v)).toString('hex')),
      unpack:entradas.map(h=>e.unpack(Buffer.from(h,'hex')))};
    process.stdout.write(JSON.stringify(out));process.exit(0);`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script, nativo, JSON.stringify({ casos, entradas })], { timeout: 30_000 }));
}

test('diferencial: port JS ≡ discord_erlpack.node (byte a byte)', { skip: !nativo && 'Discord não instalado' }, () => {
  const casos = [null, true, false, 0, 255, 256, -1, -129, 2 ** 31 - 1, 2 ** 31, 2 ** 40, 2 ** 53, 1.5, -0.25, 1e300,
    '', 'oi', 'ção 🎉', [], [1, 'a', [2, []]], {}, { a: 1, b: { c: [null, true, 'x'] } },
    { op: 2, d: { token: 'abc', properties: { os: 'windows' }, intents: 3276799, compress: false } }];
  const entradas = ['836e0800ffffffffffffff0f', '836e040000000080', '836e040100000080', '836e0401ffffff7f', '836e050000000000ff', '836b0003010203', '83680261016102',
    '8364000474727565', ...casos.map((v) => hex(pack(v)))];
  const r = noNativo(casos, entradas);
  casos.forEach((v, i) => assert.equal(hex(pack(v)), r.pack[i], `pack(${JSON.stringify(v)})`));
  entradas.forEach((h, i) => assert.deepEqual(unpack(bytes(h)), r.unpack[i], `unpack(${h})`));
});
