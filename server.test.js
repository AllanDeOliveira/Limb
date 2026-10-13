// Ponta a ponta: sobe o server.js num banco temporário e conversa com ele como dois clientes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'limb-'));
let proc, B;

const outros = [];
function subir(env = {}) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DB_FILE: path.join(dir, `db${outros.length}.sqlite`), ...env } });
  outros.push(p);
  return new Promise((res, rej) => {
    p.stdout.on('data', (d) => { const m = /localhost:(\d+)/.exec(d); if (m) res(`http://localhost:${m[1]}`); });
    p.on('exit', () => rej(new Error('servidor saiu')));
  });
}
before(async () => { B = await subir({ ICE_SERVERS: '[{"urls":"stun:exemplo:3478"}]' }); });
after(async () => {
  await Promise.all(outros.map((p) => { const saiu = new Promise((r) => p.once('exit', r)); p.kill(); return saiu; }));
  rmSync(dir, { recursive: true, force: true }); // Windows não apaga o banco enquanto o processo o mantém aberto
});

const api = async (m, p, body, token, base = B) => {
  const r = await fetch(`${base}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: token ?? '' }, body: body && JSON.stringify(body) });
  return [r.status, r.status === 204 ? null : await r.json()];
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Cliente mínimo de gateway: guarda tudo que chega
function conectar(primeiro) {
  return new Promise((res) => {
    const ws = new WebSocket(B.replace('http', 'ws') + '/gateway');
    const ev = [];
    ws.onmessage = (e) => {
      const p = JSON.parse(e.data);
      ev.push(p);
      if (p.op === 10) ws.send(JSON.stringify(primeiro));
      if (p.t === 'READY' || p.t === 'RESUMED' || p.op === 9) res({ ws, ev, last: () => ev.filter((x) => x.op === 0).at(-1)?.s ?? 0 });
    };
  });
}
const identify = (token) => conectar({ op: 2, d: { token } });

test('fluxo completo', async (t) => {
  const [s1, a] = await api('POST', '/login', { username: 'Ana', password: 'senha-ana' });
  assert.equal(s1, 200); assert.equal(a.user.username, 'ana');
  assert.equal((await api('POST', '/login', { username: 'x', password: 'senha-ana' }))[0], 400);
  assert.equal((await api('POST', '/login', { username: 'nova', password: '123' }))[0], 400); // senha curta
  const [s2, a2] = await api('POST', '/login', { username: 'ana', password: 'senha-ana' });
  assert.equal(s2, 200); assert.equal(a2.token, a.token); // mesma conta
  assert.equal((await api('POST', '/login', { username: 'ana', password: 'errada!' }))[0], 401);
  assert.deepEqual((await api('GET', '/info'))[1], { convite: false });
  const [, b] = await api('POST', '/login', { username: 'bia', password: 'senha-bia' });

  const A = await identify(a.token), Bc = await identify(b.token);
  const ready = A.ev.find((p) => p.t === 'READY').d;
  assert.equal(A.ev[0].d.heartbeat_interval, 41250);
  assert.match(ready.session_id, /^[0-9a-f]{32}$/);
  const ch = ready.guilds[0].channels[0];
  const g = ready.guilds[0].id;

  await t.test('heartbeat, presença e seq', async () => {
    A.ws.send(JSON.stringify({ op: 1, d: null }));
    await wait(100);
    assert.ok(A.ev.some((p) => p.op === 11));
    assert.ok(A.ev.some((p) => p.t === 'PRESENCE_UPDATE' && p.d.user.username === 'bia' && p.d.status === 'online'));
  });

  let m1;
  await t.test('mensagem com nonce, menção e contador de menções', async () => {
    [, m1] = await api('POST', `/channels/${ch.id}/messages`, { content: 'oi @bia, olha https://x.com', nonce: '123' }, a.token);
    await wait(100);
    const ev = Bc.ev.find((p) => p.t === 'MESSAGE_CREATE');
    assert.equal(ev.d.nonce, '123');
    assert.deepEqual(ev.d.mentions, [b.user.id]);
    // bia reconecta do zero: READY traz a menção pendente
    const B2 = await identify(b.token);
    const rs = B2.ev.find((p) => p.t === 'READY').d.read_state.find((r) => r.channel_id === ch.id);
    assert.equal(rs.mention_count, 1);
    B2.ws.close(1000);
  });

  await t.test('ack zera menções e avisa as abas do mesmo usuário', async () => {
    assert.equal((await api('POST', `/channels/${ch.id}/messages/${m1.id}/ack`, null, b.token))[0], 204);
    await wait(100);
    assert.ok(Bc.ev.some((p) => p.t === 'MESSAGE_ACK' && p.d.message_id === m1.id));
    assert.ok(!A.ev.some((p) => p.t === 'MESSAGE_ACK')); // não vaza para outro usuário
  });

  let m2;
  await t.test('resposta (message_reference / referenced_message)', async () => {
    [, m2] = await api('POST', `/channels/${ch.id}/messages`, { content: 'bom dia @ana', message_reference: { message_id: m1.id } }, b.token);
    assert.deepEqual(m2.message_reference, { message_id: m1.id, channel_id: ch.id });
    assert.equal(m2.referenced_message.author.username, 'ana');
    assert.equal((await api('POST', `/channels/${ch.id}/messages`, { content: 'x', message_reference: { message_id: '1' } }, b.token))[0], 404);
  });

  await t.test('reações: add idempotente, me por usuário, remove, emoji inválido', async () => {
    const r = (m, e, tok) => api(m, `/channels/${ch.id}/messages/${m1.id}/reactions/${encodeURIComponent(e)}/@me`, null, tok);
    assert.equal((await r('PUT', '👍', a.token))[0], 204);
    await r('PUT', '👍', a.token);
    await r('PUT', '👍', b.token);
    assert.equal((await r('PUT', 'abc', a.token))[0], 400);
    const [, hist] = await api('GET', `/channels/${ch.id}/messages`, null, a.token);
    assert.deepEqual(hist.find((m) => m.id === m1.id).reactions, [{ emoji: '👍', count: 2, me: true }]);
    await r('DELETE', '👍', a.token);
    const [, hist2] = await api('GET', `/channels/${ch.id}/messages`, null, a.token);
    assert.deepEqual(hist2.find((m) => m.id === m1.id).reactions, [{ emoji: '👍', count: 1, me: false }]);
    await wait(100);
    assert.equal(Bc.ev.filter((p) => p.t === 'MESSAGE_REACTION_ADD').length, 2);
    assert.equal(Bc.ev.filter((p) => p.t === 'MESSAGE_REACTION_REMOVE').length, 1);
  });

  await t.test('histórico paginado e busca', async () => {
    const [, hist] = await api('GET', `/channels/${ch.id}/messages`, null, a.token);
    assert.equal(hist[0].id, m2.id);
    const [, page] = await api('GET', `/channels/${ch.id}/messages?before=${m2.id}`, null, a.token);
    assert.deepEqual(page.map((m) => m.id), [m1.id]);
    const se = async (q) => (await api('GET', `/guilds/${g}/messages/search?q=${encodeURIComponent(q)}`, null, a.token))[1];
    assert.equal((await se('from:ana')).total_results, 1);
    assert.equal((await se('has:link')).messages[0].id, m1.id);
    assert.equal((await se('mentions:bia')).messages[0].id, m1.id);
    assert.equal((await se('-from:ana in:geral')).messages[0].id, m2.id);
    assert.equal((await se('has:mention')).total_results, 2);
  });

  await t.test('RESUME reenvia o que foi perdido; sessão inválida recebe op 9', async () => {
    const sid = ready.session_id, seq = A.last();
    A.ws.close(4000); // queda de rede: sessão fica esperando
    await wait(100);
    await api('POST', `/channels/${ch.id}/messages`, { content: 'enquanto ana estava fora' }, b.token);
    const R = await conectar({ op: 6, d: { token: a.token, session_id: sid, seq } });
    const tipos = R.ev.filter((p) => p.op === 0).map((p) => p.t);
    assert.deepEqual(tipos.slice(-2), ['MESSAGE_CREATE', 'RESUMED']);
    assert.equal(R.ev.find((p) => p.t === 'MESSAGE_CREATE').s, seq + 1);
    const X = await conectar({ op: 6, d: { token: a.token, session_id: 'nao-existe', seq: 0 } });
    assert.ok(X.ev.some((p) => p.op === 9));
    X.ws.close();
    R.ws.close(1000);
  });

  await t.test('permissões e validação', async () => {
    assert.equal((await api('PATCH', `/channels/${ch.id}/messages/${m1.id}`, { content: 'hack' }, b.token))[0], 403);
    const [s, ed] = await api('PATCH', `/channels/${ch.id}/messages/${m1.id}`, { content: 'editada' }, a.token);
    assert.equal(s, 200); assert.ok(ed.edited_timestamp);
    assert.equal((await api('DELETE', `/channels/${ch.id}/messages/${m1.id}`, null, a.token))[0], 204);
    const [, hist] = await api('GET', `/channels/${ch.id}/messages`, null, a.token);
    assert.equal(hist.find((m) => m.id === m2.id).referenced_message, null); // original apagada
    assert.equal((await api('GET', `/channels/${ch.id}/messages`))[0], 401);
    assert.equal((await api('POST', `/channels/${ch.id}/messages`, { content: 'x'.repeat(2001) }, a.token))[0], 400);
    assert.notEqual((await fetch(`${B}/..%2f..%2fserver.js`)).status, 200);
  });

  await t.test('gateway em ETF (?encoding=etf): frames binários, snowflake chega como string', async () => {
    const { pack, unpack } = await import('./public/etf.js');
    const ev = await new Promise((res) => {
      const ws = new WebSocket(B.replace('http', 'ws') + '/gateway?encoding=etf');
      ws.binaryType = 'arraybuffer';
      const ev = [];
      ws.onmessage = (e) => {
        assert.ok(e.data instanceof ArrayBuffer); // binário, não texto
        const p = unpack(e.data);
        ev.push(p);
        if (p.op === 10) ws.send(pack({ op: 2, d: { token: a.token } }));
        if (p.t === 'READY') { ws.close(1000); res(ev); }
      };
    });
    const r = ev.find((p) => p.t === 'READY').d;
    assert.equal(r.user.id, a.user.id); // BigInt → SMALL_BIG → string decimal, igual ao JSON
    assert.equal(r.guilds[0].channels[0].id, ch.id);
  });

  await t.test('voz: op 4 → VOICE_SERVER_UPDATE → gateway de voz, sinalização entre pares', async () => {
    const vc = ready.guilds[0].channels.find((c) => c.type === 2);
    assert.ok(vc, 'servidor novo vem com canal de voz');
    const A2 = await identify(a.token), B2 = await identify(b.token);
    const esperar = async (cli, pred, ms = 2000) => {
      for (const fim = Date.now() + ms; Date.now() < fim; await wait(20)) { const e = cli.ev.find(pred); if (e) return e; }
      throw new Error('evento não chegou');
    };
    // cliente do gateway de voz: guarda tudo, responde HELLO com IDENTIFY
    const voz = (vsu, user, sessionId) => new Promise((res) => {
      const ws = new WebSocket(B.replace('http', 'ws') + vsu.endpoint);
      const ev = [];
      ws.onmessage = (e) => {
        const p = JSON.parse(e.data);
        ev.push(p);
        if (p.op === 8) ws.send(JSON.stringify({ op: 0, d: { server_id: vsu.guild_id, user_id: user.id, session_id: sessionId, token: vsu.token } }));
        if (p.op === 2) res({ ws, ev });
      };
      ws.onclose = (e) => { ev.push({ closed: e.code }); res({ ws, ev }); };
    });
    const sid = (cli) => cli.ev.find((p) => p.t === 'READY').d.session_id;

    A2.ws.send(JSON.stringify({ op: 4, d: { guild_id: g, channel_id: vc.id, self_mute: false, self_deaf: false } }));
    const vsuA = (await esperar(A2, (p) => p.t === 'VOICE_SERVER_UPDATE')).d;
    await esperar(B2, (p) => p.t === 'VOICE_STATE_UPDATE' && p.d.user_id === a.user.id && p.d.channel_id === vc.id);
    const VA = await voz(vsuA, a.user, sid(A2));
    assert.equal(VA.ev[0].op, 8);
    assert.ok(VA.ev.find((p) => p.op === 2).d.ssrc > 0);
    assert.deepEqual(VA.ev.find((p) => p.op === 2).d.ice_servers, [{ urls: 'stun:exemplo:3478' }]);

    // ana compartilha a tela antes da bia chegar
    A2.ws.send(JSON.stringify({ op: 4, d: { guild_id: g, channel_id: vc.id, self_stream: true } }));
    await esperar(B2, (p) => p.t === 'VOICE_STATE_UPDATE' && p.d.user_id === a.user.id && p.d.self_stream === true);
    VA.ws.send(JSON.stringify({ op: 12, d: { stream_id: '{tela-123}' } }));
    await wait(50);

    // token é de uso único
    const reuso = await voz(vsuA, a.user, sid(A2));
    assert.equal(reuso.ev.at(-1).closed, 4004);

    B2.ws.send(JSON.stringify({ op: 4, d: { guild_id: g, channel_id: vc.id, self_mute: true, self_deaf: false } }));
    const vsuB = (await esperar(B2, (p) => p.t === 'VOICE_SERVER_UPDATE')).d;
    const VB = await voz(vsuB, b.user, sid(B2));
    await wait(50);
    assert.deepEqual(VB.ev.find((p) => p.op === 11).d.user_ids, [a.user.id]); // quem já estava
    // a tela da ana chega antes de CLIENTS_CONNECT, para a bia reconhecer o stream ao receber
    const iVideo = VB.ev.findIndex((p) => p.op === 12), iConn = VB.ev.findIndex((p) => p.op === 11);
    assert.ok(iVideo >= 0 && iVideo < iConn);
    assert.deepEqual(VB.ev[iVideo].d, { user_id: a.user.id, stream_id: '{tela-123}' });
    VA.ws.send(JSON.stringify({ op: 12, d: { stream_id: '<script>' } })); // id inválido vira null
    await wait(50);
    assert.deepEqual(VB.ev.filter((p) => p.op === 12).at(-1).d, { user_id: a.user.id, stream_id: null });
    assert.deepEqual(VA.ev.filter((p) => p.op === 11).at(-1).d.user_ids, [b.user.id]); // quem chegou

    // sinalização WebRTC repassada só ao destinatário, com o remetente carimbado pelo servidor
    VB.ws.send(JSON.stringify({ op: 100, d: { to: a.user.id, from: 'forjado', description: { type: 'offer', sdp: 'v=0' } } }));
    VB.ws.send(JSON.stringify({ op: 5, d: { speaking: 1, delay: 0, ssrc: 1 } }));
    await wait(80);
    assert.deepEqual(VA.ev.find((p) => p.op === 100).d, { from: b.user.id, description: { type: 'offer', sdp: 'v=0' } });
    assert.equal(VA.ev.find((p) => p.op === 5).d.user_id, b.user.id);

    // bia sai do canal: ana recebe CLIENT_DISCONNECT e o gateway de voz da bia é fechado com 4014
    B2.ws.send(JSON.stringify({ op: 4, d: { guild_id: g, channel_id: null } }));
    await wait(100);
    assert.equal(VA.ev.find((p) => p.op === 13).d.user_id, b.user.id);
    assert.equal(VB.ev.at(-1).closed, 4014);
    await esperar(A2, (p) => p.t === 'VOICE_STATE_UPDATE' && p.d.user_id === b.user.id && p.d.channel_id === null);

    // canal de texto não é canal de voz
    A2.ws.send(JSON.stringify({ op: 4, d: { guild_id: g, channel_id: ch.id } }));
    await esperar(A2, (p) => p.t === 'VOICE_STATE_ERROR');

    // ana fecha a sessão principal: sai da voz junto
    A2.ws.close(1000);
    await esperar(B2, (p) => p.t === 'VOICE_STATE_UPDATE' && p.d.user_id === a.user.id && p.d.channel_id === null);
    VA.ws.close(); B2.ws.close(1000);
  });

  await t.test('código de convite: conta nova só com o código; conta existente não precisa', async () => {
    const C = await subir({ INVITE_CODE: 'amigos' });
    assert.deepEqual((await api('GET', '/info', null, null, C))[1], { convite: true });
    assert.equal((await api('POST', '/login', { username: 'zé', password: 'segredo1' }, null, C))[0], 400);
    assert.equal((await api('POST', '/login', { username: 'ze', password: 'segredo1' }, null, C))[0], 403);
    assert.equal((await api('POST', '/login', { username: 'ze', password: 'segredo1', invite: 'amigos' }, null, C))[0], 200);
    assert.equal((await api('POST', '/login', { username: 'ze', password: 'segredo1' }, null, C))[0], 200);
  });

  await t.test('saída intencional (1000) deixa offline na hora; token ruim fecha 4004', async () => {
    const C = await identify(a.token); // ana online de novo para ver a bia sair
    Bc.ws.close(1000);
    await wait(150);
    assert.ok(C.ev.some((p) => p.t === 'PRESENCE_UPDATE' && p.d.user.username === 'bia' && p.d.status === 'offline'));
    const code = await new Promise((res) => {
      const ws = new WebSocket(B.replace('http', 'ws') + '/gateway');
      ws.onmessage = (e) => { if (JSON.parse(e.data).op === 10) ws.send(JSON.stringify({ op: 2, d: { token: 'nope' } })); };
      ws.onclose = (e) => res(e.code);
    });
    assert.equal(code, 4004);
    C.ws.close(1000);
  });
});
