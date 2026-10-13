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
  // quem já saiu (o teste do banco antigo reinicia um servidor) não emite mais "exit"
  await Promise.all(outros.filter((p) => p.exitCode === null && p.signalCode === null)
    .map((p) => { const saiu = new Promise((r) => p.once('exit', r)); p.kill(); return saiu; }));
  rmSync(dir, { recursive: true, force: true }); // Windows não apaga o banco enquanto o processo o mantém aberto
});

const api = async (m, p, body, token, base = B) => {
  const r = await fetch(`${base}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: token ?? '' }, body: body && JSON.stringify(body) });
  return [r.status, r.status === 204 ? null : await r.json()];
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Cliente mínimo de gateway: guarda tudo que chega
function conectar(primeiro, base = B) {
  return new Promise((res) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/gateway');
    const ev = [];
    const fechou = new Promise((r) => { ws.onclose = (e) => { ev.push({ closed: e.code }); r(e.code); }; });
    ws.onmessage = (e) => {
      const p = JSON.parse(e.data);
      ev.push(p);
      if (p.op === 10) ws.send(JSON.stringify(primeiro));
      if (p.t === 'READY' || p.t === 'RESUMED' || p.op === 9) res({ ws, ev, fechou, last: () => ev.filter((x) => x.op === 0).at(-1)?.s ?? 0 });
    };
    fechou.then(() => res({ ws, ev, fechou })); // fechou antes do READY (ex.: 4004)
  });
}
const identify = (token, base) => conectar({ op: 2, d: { token } }, base);
const SENHA_ANA = 'pao-de-queijo-7', SENHA_BIA = 'cafe-com-leite-9';

test('fluxo completo', async (t) => {
  const [s1, a] = await api('POST', '/register', { username: 'Ana', password: SENHA_ANA });
  assert.equal(s1, 200); assert.equal(a.user.username, 'ana'); assert.match(a.token, /^[\w-]{43}$/);
  assert.equal((await api('POST', '/register', { username: 'ana', password: 'outra-senha-boa' }))[0], 409);
  assert.equal((await api('POST', '/login', { username: 'x', password: SENHA_ANA }))[0], 400);
  assert.equal((await api('POST', '/register', { username: 'nova', password: '123' }))[0], 400); // senha curta
  assert.equal((await api('POST', '/register', { username: 'nova', password: '12345678' }))[0], 400); // senha comum
  assert.equal((await api('POST', '/register', { username: 'nova', password: 'xx-NOVA-xx' }))[0], 400); // contém o nome
  // login não cria conta: nome desconhecido dá o mesmo erro que senha errada
  const [s0, ninguem] = await api('POST', '/login', { username: 'ninguem', password: SENHA_ANA });
  assert.equal(s0, 401);
  const [s2, a2] = await api('POST', '/login', { username: 'ana', password: SENHA_ANA });
  assert.equal(s2, 200); assert.equal(a2.user.id, a.user.id); assert.notEqual(a2.token, a.token); // mesma conta, outro dispositivo
  const [s3, errada] = await api('POST', '/login', { username: 'ana', password: 'errada!' });
  assert.equal(s3, 401); assert.equal(errada.message, ninguem.message);
  assert.deepEqual((await api('GET', '/info'))[1], { convite: false });
  const [, b] = await api('POST', '/register', { username: 'bia', password: SENHA_BIA });

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

  await t.test('código de convite: conta nova só com o código; entrar não precisa', async () => {
    const C = await subir({ INVITE_CODE: 'amigos' });
    assert.deepEqual((await api('GET', '/info', null, null, C))[1], { convite: true });
    const conta = { username: 'ze', password: 'segredo-123x' };
    assert.equal((await api('POST', '/register', { ...conta, username: 'zé' }, null, C))[0], 400);
    assert.equal((await api('POST', '/register', conta, null, C))[0], 403);
    assert.equal((await api('POST', '/register', { ...conta, invite: 'errado' }, null, C))[0], 403);
    assert.equal((await api('POST', '/register', { ...conta, invite: 'amigos' }, null, C))[0], 200);
    assert.equal((await api('POST', '/login', conta, null, C))[0], 200);
  });

  await t.test('saída intencional (1000) deixa offline na hora; token ruim fecha 4004', async () => {
    const C = await identify(a.token); // ana online de novo para ver a bia sair
    Bc.ws.close(1000);
    await wait(150);
    assert.ok(C.ev.some((p) => p.t === 'PRESENCE_UPDATE' && p.d.user.username === 'bia' && p.d.status === 'offline'));
    assert.equal(await (await identify('nope')).fechou, 4004);
    C.ws.close(1000);
  });

  await t.test('sair: revoga só este dispositivo e derruba o gateway dele com 4004', async () => {
    const [, a3] = await api('POST', '/login', { username: 'ana', password: SENHA_ANA });
    const G = await identify(a3.token);
    // outra aba com o mesmo token caiu e espera um RESUME
    const H = await identify(a3.token);
    const sid = H.ev.find((p) => p.t === 'READY').d.session_id, seq = H.last();
    H.ws.close(4000);
    await wait(100);
    assert.equal((await api('POST', '/logout', null, a3.token))[0], 204);
    assert.equal(await G.fechou, 4004);
    assert.equal((await api('GET', `/channels/${ch.id}/messages`, null, a3.token))[0], 401);
    assert.equal(await (await identify(a3.token)).fechou, 4004);
    const R = await conectar({ op: 6, d: { token: a3.token, session_id: sid, seq } });
    assert.ok(R.ev.some((p) => p.op === 9)); // token revogado não retoma
    R.ws.close();
    assert.equal((await api('GET', `/channels/${ch.id}/messages`, null, a.token))[0], 200); // os outros dispositivos da ana seguem
    assert.equal((await api('POST', '/logout', null, a3.token))[0], 401);
  });

  await t.test('trocar a senha desconecta os outros dispositivos (este continua)', async () => {
    const [, c1] = await api('POST', '/register', { username: 'caio', password: 'arroz-e-feijao-3' });
    const [, c2] = await api('POST', '/login', { username: 'caio', password: 'arroz-e-feijao-3' });
    const G = await identify(c2.token);
    const troca = (corpo) => api('POST', '/users/@me/password', corpo, c1.token);
    assert.equal((await troca({ senha_atual: 'errada-123', senha_nova: 'batata-frita-44' }))[0], 403);
    assert.equal((await troca({ senha_atual: 'arroz-e-feijao-3', senha_nova: 'caio1234' }))[0], 400); // contém o nome
    assert.equal(G.ws.readyState, 1); // tentativas que falham não derrubam ninguém
    assert.equal((await troca({ senha_atual: 'arroz-e-feijao-3', senha_nova: 'batata-frita-44' }))[0], 204);
    assert.equal(await G.fechou, 4004);
    assert.equal((await api('GET', '/users/@me/sessions', null, c2.token))[0], 401);
    assert.equal((await api('GET', '/users/@me/sessions', null, c1.token))[0], 200);
    assert.equal((await api('POST', '/login', { username: 'caio', password: 'arroz-e-feijao-3' }))[0], 401);
    assert.equal((await api('POST', '/login', { username: 'caio', password: 'batata-frita-44' }))[0], 200);
  });

  await t.test('dispositivos: lista, desconecta um, encerra os outros; nunca os de outra pessoa', async () => {
    // entrar pelo app desktop: o aparelho aparece com nome na lista
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) limb/1.6.1 Chrome/140.0.0.0 Electron/44.7.1 Safari/537.36';
    const r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ username: 'ana', password: SENHA_ANA }) });
    assert.equal(r.headers.get('cache-control'), 'no-store'); // resposta com token
    const app = await r.json();
    const [s, lista] = await api('GET', '/users/@me/sessions', null, a.token);
    assert.equal(s, 200);
    assert.deepEqual(Object.keys(lista[0]).sort(), ['atual', 'criado', 'dispositivo', 'id', 'usado']); // nada de hash de token
    assert.equal(lista.filter((x) => x.atual).length, 1);
    const [, daApp] = await api('GET', '/users/@me/sessions', null, app.token);
    const sessaoApp = daApp.find((x) => x.atual);
    assert.equal(sessaoApp.dispositivo, 'App Limb · Windows');
    assert.match(sessaoApp.id, /^\d+$/);
    assert.ok(lista.some((x) => x.id === sessaoApp.id));
    const [, daBia] = await api('GET', '/users/@me/sessions', null, b.token);
    assert.ok(!daBia.some((x) => x.id === sessaoApp.id)); // só as da própria conta
    assert.equal((await api('DELETE', `/users/@me/sessions/${daBia.find((x) => x.atual).id}`, null, a.token))[0], 404); // não é dela
    assert.equal((await api('GET', '/users/@me/sessions', null, b.token))[0], 200);
    assert.equal((await api('DELETE', `/users/@me/sessions/${sessaoApp.id}`, null, a.token))[0], 204);
    assert.equal((await api('GET', '/users/@me/sessions', null, app.token))[0], 401);
    assert.equal((await api('GET', '/users/@me/sessions', null, a2.token))[0], 200);
    assert.equal((await api('POST', '/users/@me/sessions/encerrar-outras', null, a.token))[0], 204);
    assert.equal((await api('GET', '/users/@me/sessions', null, a2.token))[0], 401);
    const [, so] = await api('GET', '/users/@me/sessions', null, a.token);
    assert.deepEqual(so.map((x) => x.atual), [true]);
  });
});

test('limite por conta: 5 erros seguidos travam a conta, até para a senha certa (429)', async () => {
  const D = await subir();
  assert.equal((await api('POST', '/register', { username: 'duda', password: 'goiabada-cascao' }, null, D))[0], 200);
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/login', { username: 'duda', password: `errada-${i}` }, null, D))[0], 401);
  const [s, r] = await api('POST', '/login', { username: 'duda', password: 'goiabada-cascao' }, null, D);
  assert.equal(s, 429);
  assert.match(r.message, /Tente de novo em \d+ s\./);
  assert.ok(r.retry_after > 0 && r.retry_after <= 60);
  // outra conta, mesmo IP: entra normalmente
  assert.equal((await api('POST', '/register', { username: 'edu', password: 'doce-de-leite' }, null, D))[0], 200);
  assert.equal((await api('POST', '/login', { username: 'edu', password: 'doce-de-leite' }, null, D))[0], 200);
});

test('cadastro com nome ocupado conta como erro do IP; atrás de proxy, o IP é o último do X-Forwarded-For', async () => {
  const P = await subir({ TRUST_PROXY: '1' });
  const cadastrar = (xff, username = 'gabi') => fetch(`${P}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff },
    body: JSON.stringify({ username, password: 'quindim-de-coco' }) }).then((r) => r.status);
  assert.equal(await cadastrar('10.0.0.5'), 200);
  // o cliente inventa o primeiro endereço a cada pedido; o proxy acrescenta o de verdade no fim
  for (let i = 0; i < 10; i++) assert.equal(await cadastrar(`1.2.3.${i}, 10.0.0.5`), 409);
  assert.equal(await cadastrar('9.9.9.9, 10.0.0.5', 'outro.nome'), 429);
  assert.equal(await cadastrar('10.0.0.6'), 409); // outro IP segue livre
});

test('banco antigo: token e senha de antes continuam valendo; conta sem senha pede o convite', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { randomBytes, scryptSync } = await import('node:crypto');
  const arq = path.join(dir, 'antigo.sqlite');
  // esquema e formatos da versão anterior: token fixo em texto puro, senha 'sal:hash' com o scrypt padrão do Node
  const velho = new DatabaseSync(arq);
  velho.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL, senha TEXT)');
  const sal = randomBytes(16);
  const inserir = velho.prepare('INSERT INTO users VALUES (?, ?, ?, ?)');
  inserir.run(1000n << 22n, 'velho', 'token-antigo', `${sal.toString('hex')}:${scryptSync('senha6', sal, 32).toString('hex')}`);
  inserir.run(1001n << 22n, 'semsenha', 'token-sem-senha', null);
  velho.close();

  const V = await subir({ DB_FILE: arq, INVITE_CODE: 'amigos' });
  const G = await identify('token-antigo', V);
  assert.equal(G.ev.find((p) => p.t === 'READY')?.d.user.username, 'velho'); // ninguém precisa entrar de novo
  G.ws.close(1000);
  const [s, sessoes] = await api('GET', '/users/@me/sessions', null, 'token-antigo', V);
  assert.equal(s, 200);
  assert.equal(sessoes[0].dispositivo, 'Sessão anterior');
  const [s1, novo] = await api('POST', '/login', { username: 'velho', password: 'senha6' }, null, V); // senha de 6 ainda entra
  assert.equal(s1, 200);
  assert.notEqual(novo.token, 'token-antigo');

  // no banco: hash da senha refeito no formato novo; o token de verdade não fica em lugar nenhum
  const leitura = new DatabaseSync(arq, { readOnly: true });
  const linha = leitura.prepare("SELECT senha, token FROM users WHERE name = 'velho'").get();
  const hashes = leitura.prepare('SELECT token_hash FROM sessions').all().map((x) => x.token_hash);
  leitura.close();
  assert.match(linha.senha, /^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(linha.token, 'token-antigo');
  assert.ok(hashes.length >= 3 && hashes.every((x) => /^[0-9a-f]{64}$/.test(x)));
  assert.equal((await api('POST', '/login', { username: 'velho', password: 'senha6' }, null, V))[0], 200);
  assert.equal((await api('POST', '/login', { username: 'velho', password: 'senha7' }, null, V))[0], 401);

  // conta sem senha: com convite no servidor, só reivindica quem tem o código
  const [s2, r2] = await api('POST', '/login', { username: 'semsenha', password: 'nova-senha-boa' }, null, V);
  assert.equal(s2, 403);
  assert.equal(r2.convite, true);
  assert.equal((await api('POST', '/login', { username: 'semsenha', password: 'nova-senha-boa', invite: 'amigos' }, null, V))[0], 200);
  assert.equal((await api('POST', '/login', { username: 'semsenha', password: 'nova-senha-boa' }, null, V))[0], 200);

  // reiniciar não roda a migração de novo: o token antigo segue valendo
  const p = outros.at(-1);
  await new Promise((r) => { p.once('exit', r); p.kill(); });
  const V2 = await subir({ DB_FILE: arq, INVITE_CODE: 'amigos' });
  assert.equal((await api('GET', '/users/@me/sessions', null, 'token-antigo', V2))[0], 200);
  assert.equal((await api('GET', '/users/@me/sessions', null, 'token-sem-senha', V2))[0], 200);
  assert.equal((await api('POST', '/login', { username: 'velho', password: 'senha6' }, null, V2))[0], 200);
});
