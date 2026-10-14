// Ponta a ponta: sobe o server.js num banco temporário e conversa com ele como dois clientes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'limb-'));
const VERSAO = JSON.parse(readFileSync('package.json', 'utf8')).version;
let proc, B;

const outros = [];
// ipc: canal do child_process.fork, no lugar do process.parentPort do app desktop
function subir(env = {}, { ipc = false } = {}) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', DB_FILE: path.join(dir, `db${outros.length}.sqlite`), ...env },
    ...(ipc && { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }) });
  outros.push(p);
  p.log = ''; // stderr: para conferir o que o servidor registra
  p.stderr.on('data', (d) => { p.log += d; });
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
  assert.deepEqual((await api('GET', '/info'))[1], { convite: false, primeiraConta: false, semDono: false, nome: 'Limb', versao: VERSAO });
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

  await t.test('convite: a primeira conta (do dono) não precisa; as outras só com o código do link; entrar não precisa', async () => {
    const C = await subir({ INVITE_CODE: 'amigos' });
    assert.deepEqual((await api('GET', '/info', null, null, C))[1], { convite: false, primeiraConta: true, semDono: false, nome: 'Limb', versao: VERSAO });
    // dois "primeiros" ao mesmo tempo, sem convite: só um vira dono
    const corrida = await Promise.all(['dono', 'intruso'].map((n) => api('POST', '/register', { username: n, password: 'pudim-de-leite-9' }, null, C)));
    assert.deepEqual(corrida.map(([s]) => s).sort(), [200, 403]);
    assert.deepEqual((await api('GET', '/info', null, null, C))[1], { convite: true, primeiraConta: false, semDono: false, nome: 'Limb', versao: VERSAO });
    const conta = { username: 'ze', password: 'segredo-123x' };
    assert.equal((await api('POST', '/register', { ...conta, username: 'zé' }, null, C))[0], 400);
    const [s1, sem] = await api('POST', '/register', conta, null, C);
    assert.equal(s1, 403); assert.equal(sem.convite, true); assert.match(sem.message, /só aceita convidados/);
    const [s2, errado] = await api('POST', '/register', { ...conta, invite: 'errado' }, null, C);
    assert.equal(s2, 403); assert.equal(errado.convite, true); assert.match(errado.message, /não vale mais/);
    assert.ok(!/c[óo]digo/i.test(sem.message + errado.message)); // ninguém digita código
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

test('página de convite: nome e código escapados, prévia (og:) e cabeçalhos; sem caixa de código; o modelo cru não sai', async () => {
  // {{codigo}} no nome prova que a troca é numa passada só; o código também tem <script> e aspas
  const NOME = `Turma <script>alert("x")</script> d'Ana {{codigo}}`;
  const CODIGO = `a<script>"'&b`;
  const C = await subir({ SERVER_NAME: `  ${NOME}  `, INVITE_CODE: CODIGO });
  const r = await fetch(`${C}/convite/${encodeURIComponent(CODIGO)}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await r.text();
  assert.ok(!html.includes('<script>alert') && !html.includes('a<script>'));
  const nome = 'Turma &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; d&#39;Ana {{codigo}}';
  const codigo = 'a&lt;script&gt;&quot;&#39;&amp;b';
  assert.ok(html.includes(`<meta property="og:title" content="Convite para ${nome} no Limb">`));
  assert.ok(html.includes(`<meta property="og:description" content="Você foi convidado para ${nome}.`));
  assert.ok(html.includes('<meta property="og:type" content="website">'));
  assert.ok(html.includes('<meta name="twitter:card" content="summary">'));
  assert.ok(html.includes(`Você foi convidado para <b>${nome}</b>`));
  assert.ok(html.includes(`data-codigo="${codigo}"`));
  assert.ok(html.includes(`href="/#convite=a%3Cscript%3E%22&#39;%26b"`));
  assert.ok(html.includes(`href="https://github.com/AllanDeOliveira/Limb/releases/download/v${VERSAO}/Limb-${VERSAO}-instalador.exe"`));
  assert.ok(html.includes('id="baixar"') && html.includes('id="abrirApp"'));
  // o link é o convite: nenhuma caixa nem texto pedindo código
  assert.ok(!html.includes(`value="${codigo}"`) && !/c[óo]digo/i.test(html.replaceAll(nome, '').replace(/<!--[\s\S]*?-->|data-codigo="[^"]*"/g, '')));
  assert.ok(!html.includes('não vale mais') && !html.includes('<!--valido'));
  assert.ok(!/\{\{\w+\}\}/.test(html.replaceAll(nome, ''))); // nenhum marcador sobrando
  assert.ok(html.includes('<script type="module" src="/convite.js"></script>')); // absoluto: a página mora em /convite/…

  // código errado (link antigo), sem código, quebrado ou comprido demais: "não vale mais", 404, sem botões
  for (const p of ['/convite/errado', '/convite', '/convite/', '/convite/%E0%A4%A', `/convite/${'x'.repeat(101)}`]) {
    const s = await fetch(C + p);
    assert.equal(s.status, 404, p);
    assert.equal(s.headers.get('content-type'), 'text/html; charset=utf-8', p);
    assert.equal(s.headers.get('cache-control'), 'no-store', p);
    assert.equal(s.headers.get('x-frame-options'), 'DENY', p);
    const h = await s.text();
    assert.ok(h.includes('Este convite não vale mais') && h.includes('Peça um link novo para quem te convidou.'), p);
    assert.ok(!h.includes('class="botao') && !h.includes('id="navegador"') && !h.includes('/convite.js'), p);
    assert.ok(h.includes('<meta property="og:title" content="Convite do Limb">'), p);
    assert.ok(!h.includes('Turma'), p); // o nome do servidor não aparece para quem não foi convidado
  }
  // servidor sem código de convite: qualquer link serve
  const A = await subir({ SERVER_NAME: 'Aberto' });
  for (const p of ['/convite', '/convite/qualquer']) {
    const s = await fetch(A + p);
    assert.equal(s.status, 200, p);
    assert.ok((await s.text()).includes('id="navegador" href="/'), p);
  }
  // o modelo cru não é servido, nem pelos outros nomes que o Windows aceita para o mesmo arquivo
  for (const p of ['/convite.html', '/CONVITE.HTML', '/convite.html.', '/convite.html::$DATA', '/CONVIT~1.HTM', '/convite/a/b']) {
    assert.equal((await fetch(C + p)).status, 404, p);
  }
  const js = await fetch(`${C}/convite.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript');
  assert.equal(js.headers.get('x-frame-options'), null); // só HTML leva a proteção de moldura
  const raiz = await fetch(`${C}/`);
  assert.equal(raiz.status, 200);
  assert.equal(raiz.headers.get('x-frame-options'), 'DENY');
  assert.match(raiz.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.deepEqual((await api('GET', '/info', null, null, C))[1], { convite: false, primeiraConta: true, semDono: false, nome: NOME, versao: VERSAO }); // ainda sem contas
});

test('página de convite não serve para chutar códigos: cada código errado conta no limite por IP', async () => {
  const C = await subir({ INVITE_CODE: 'k7m2pq9xa3bc' });
  const ver = (codigo, ip) => fetch(`${C}/convite/${codigo}`, { headers: { 'X-Forwarded-For': ip } });
  for (let i = 0; i < 10; i++) assert.equal((await ver(`chute${i}`, '203.0.113.9')).status, 404);
  // bloqueado: até o código certo aparece como "não vale mais" (não dá para saber se acertou)
  const bloqueada = await ver('k7m2pq9xa3bc', '203.0.113.9');
  assert.equal(bloqueada.status, 404);
  assert.ok((await bloqueada.text()).includes('não vale mais'));
  // o mesmo limite do cadastro: quem chutou na página também não cria conta
  const cadastro = await fetch(`${C}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' },
    body: JSON.stringify({ username: 'chutador', password: 'pudim-de-leite', invite: 'k7m2pq9xa3bc' }) });
  assert.equal(cadastro.status, 429);
  // outra pessoa (outro IP pelo mesmo Funnel) segue entrando
  assert.equal((await ver('k7m2pq9xa3bc', '198.51.100.7')).status, 200);
  // sem código não chuta nada: não conta
  for (let i = 0; i < 12; i++) assert.equal((await ver('', '192.0.2.1')).status, 404);
  assert.equal((await ver('k7m2pq9xa3bc', '192.0.2.1')).status, 200);
});

test('primeira conta sem convite: só deste computador; pela internet (Funnel/proxy) o servidor vazio pede convite', async () => {
  const S = await subir({ INVITE_CODE: 'k7m2pq9xa3bc' });
  const de = (cab) => ({ 'Content-Type': 'application/json', ...cab });
  const info = async (cab) => (await fetch(`${S}/api/info`, { headers: de(cab) })).json();
  const cadastrar = (cab, corpo) => fetch(`${S}/api/register`, { method: 'POST', headers: de(cab), body: JSON.stringify({ password: 'canjica-doce-3', ...corpo }) });
  // quem chega pelo Funnel (loopback + X-Forwarded-For) não ganha a primeira conta: só fica sabendo que o servidor
  // é novo (semDono), para a tela dizer onde o dono cria a conta (e não "peça o link para quem hospeda")
  for (const cab of [{ 'X-Forwarded-For': '203.0.113.9' }, { Forwarded: 'for=203.0.113.9' }, { 'X-Real-IP': '203.0.113.9' }]) {
    assert.deepEqual(await info(cab), { convite: true, primeiraConta: false, semDono: true, nome: 'Limb', versao: VERSAO }, JSON.stringify(cab));
  }
  const robo = await cadastrar({ 'X-Forwarded-For': '203.0.113.9' }, { username: 'robo' });
  assert.equal(robo.status, 403);
  const negado = await robo.json();
  assert.equal(negado.convite, true);
  assert.match(negado.message, /Servidor novo: crie a primeira conta no app do Limb de quem hospeda/);
  // mas com o link de convite entra normalmente, mesmo sendo o primeiro
  const amigo = await cadastrar({ 'X-Forwarded-For': '198.51.100.7' }, { username: 'amigo', invite: 'k7m2pq9xa3bc' });
  assert.equal(amigo.status, 200);
  assert.equal((await info({ 'X-Forwarded-For': '203.0.113.9' })).semDono, false); // já tem dono
  // com uma conta criada, ninguém mais entra sem convite, nem deste computador
  const dono = await cadastrar({}, { username: 'dono' });
  assert.equal(dono.status, 403);
  assert.match((await dono.json()).message, /só aceita convidados/);
});

test('"Gerar link novo": o app troca o convite na hora, sem reiniciar; contas e sessões continuam', async () => {
  const V = await subir({ INVITE_CODE: 'velho-abc' }, { ipc: true });
  const p = outros.at(-1);
  const [, u] = await api('POST', '/register', { username: 'host', password: 'bolo-de-milho-1', invite: 'velho-abc' }, null, V);
  const pagina = async (codigo) => (await fetch(`${V}/convite/${codigo}`)).status;
  // mensagens que não são um convite válido são ignoradas
  for (const m of [{ convite: 5 }, { convite: '' }, { convite: '   ' }, { convite: 'x'.repeat(101) }, { convite: 'a\nb' }, { outra: 'coisa' }, 'texto', null]) p.send(m);
  await wait(150);
  assert.equal(await pagina('velho-abc'), 200);
  p.send({ convite: '  novo-k7m2pq  ' });
  for (const fim = Date.now() + 2000; (await pagina('novo-k7m2pq')) !== 200 && Date.now() < fim;) await wait(20);
  assert.equal(await pagina('novo-k7m2pq'), 200);
  assert.equal(await pagina('velho-abc'), 404); // o link antigo para de valer
  const conta = { username: 'amigo', password: 'cocada-preta-7' };
  assert.equal((await api('POST', '/register', { ...conta, invite: 'velho-abc' }, null, V))[0], 403);
  assert.equal((await api('POST', '/register', { ...conta, invite: 'novo-k7m2pq' }, null, V))[0], 200);
  assert.equal((await api('GET', '/users/@me/sessions', null, u.token, V))[0], 200); // quem já tinha conta segue dentro
  assert.equal((await api('POST', '/login', { username: 'host', password: 'bolo-de-milho-1' }, null, V))[0], 200);
});

test('proxy nesta máquina (Tailscale Funnel): o IP é o último do X-Forwarded-For, sem precisar de TRUST_PROXY', async () => {
  const L = await subir();
  const entrar = (xff, username) => fetch(`${L}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(xff && { 'X-Forwarded-For': xff }) },
    body: JSON.stringify({ username, password: 'senha-errada-1' }),
  }).then((r) => r.status);
  // um nome por tentativa: só o limite por IP entra em jogo (o da conta trava no 5º erro)
  for (let i = 0; i < 10; i++) assert.equal(await entrar(`6.6.6.${i}, 203.0.113.7`, `ninguem${i}`), 401);
  assert.equal(await entrar('203.0.113.7', 'ninguem10'), 429);
  assert.equal(await entrar('198.51.100.2', 'ninguem11'), 401); // outra pessoa pelo mesmo Funnel segue livre
  assert.equal(await entrar('2001:db8::1', 'ninguem12'), 401);
  assert.equal(await entrar(null, 'ninguem13'), 401); // o app de quem hospeda, sem proxy
  assert.equal(await entrar('lixo', 'ninguem14'), 401); // cabeçalho inválido: vale o IP do socket
});

// Entra no canal de voz do primeiro servidor e devolve o READY do gateway de voz
async function readyDaVoz(base, token) {
  const G = await identify(token, base);
  const ready = G.ev.find((p) => p.t === 'READY').d;
  const vc = ready.guilds[0].channels.find((c) => c.type === 2);
  G.ws.send(JSON.stringify({ op: 4, d: { guild_id: ready.guilds[0].id, channel_id: vc.id } }));
  let vsu;
  for (const fim = Date.now() + 2000; !vsu && Date.now() < fim; await wait(20)) vsu = G.ev.find((p) => p.t === 'VOICE_SERVER_UPDATE')?.d;
  assert.ok(vsu, 'VOICE_SERVER_UPDATE não chegou');
  const d = await new Promise((res, rej) => {
    const ws = new WebSocket(base.replace('http', 'ws') + vsu.endpoint);
    ws.onmessage = (e) => {
      const p = JSON.parse(e.data);
      if (p.op === 8) ws.send(JSON.stringify({ op: 0, d: { server_id: vsu.guild_id, user_id: ready.user.id, session_id: ready.session_id, token: vsu.token } }));
      if (p.op === 2) { res(p.d); ws.close(); }
    };
    ws.onclose = (e) => rej(new Error(`gateway de voz fechou (${e.code}) antes do READY`));
  });
  G.ws.close(1000);
  await wait(50);
  return d;
}
// Cloudflare de mentira: guarda os pedidos e responde com `responder`
function cloudflareFalso(responder) {
  const pedidos = [];
  const srv = http.createServer(async (req, res) => {
    let corpo = '';
    for await (const c of req) corpo += c;
    pedidos.push({ metodo: req.method, url: req.url, auth: req.headers.authorization, tipo: req.headers['content-type'], corpo });
    responder(req, res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, pedidos, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}
const TURN_ENV = { CF_TURN_KEY_ID: 'chave-1', CF_TURN_API_TOKEN: 'token-secreto' };

test('TURN da Cloudflare: credenciais no READY da voz junto com a lista fixa; uma busca só', async () => {
  const cf = await cloudflareFalso((req, res) => {
    if (req.headers.authorization !== 'Bearer token-secreto') return res.writeHead(401).end();
    res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'usuario-temporario', credential: 'senha-temporaria' },
    ] }));
  });
  try {
    const T = await subir({ ...TURN_ENV, CF_TURN_API_URL: cf.url, ICE_SERVERS: '[{"urls":"stun:exemplo:3478"}]' });
    const [, u] = await api('POST', '/register', { username: 'turno', password: 'brigadeiro-77' }, null, T);
    const ice = (await readyDaVoz(T, u.token)).ice_servers;
    // porta 53 sai: o navegador recusa
    assert.deepEqual(ice, [
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'usuario-temporario', credential: 'senha-temporaria' },
      { urls: 'stun:exemplo:3478' },
    ]);
    assert.ok(!JSON.stringify(ice).includes('token-secreto'));
    await readyDaVoz(T, u.token); // de novo: vem do cache
    assert.deepEqual(cf.pedidos, [{ metodo: 'POST', url: '/v1/turn/keys/chave-1/credentials/generate-ice-servers',
      auth: 'Bearer token-secreto', tipo: 'application/json', corpo: '{"ttl":86400}' }]);

    // sem ICE_SERVERS: o STUN do Google sai, a Cloudflare já manda um
    const T2 = await subir({ ...TURN_ENV, CF_TURN_API_URL: cf.url, ICE_SERVERS: '' });
    const [, u2] = await api('POST', '/register', { username: 'turno', password: 'brigadeiro-77' }, null, T2);
    const ice2 = (await readyDaVoz(T2, u2.token)).ice_servers;
    assert.equal(ice2.length, 2);
    assert.ok(!JSON.stringify(ice2).includes('google'));
  } finally { cf.srv.close(); }
});

test('TURN da Cloudflare fora do ar: a voz segue com a lista fixa, sem registrar o token', async () => {
  const cf = await cloudflareFalso((req, res) => res.writeHead(500).end('erro'));
  try {
    const T = await subir({ ...TURN_ENV, CF_TURN_API_URL: cf.url, ICE_SERVERS: '[{"urls":"stun:exemplo:3478"}]' });
    const p = outros.at(-1);
    const [, u] = await api('POST', '/register', { username: 'semturn', password: 'pamonha-quente' }, null, T);
    assert.deepEqual((await readyDaVoz(T, u.token)).ice_servers, [{ urls: 'stun:exemplo:3478' }]);
    assert.deepEqual((await readyDaVoz(T, u.token)).ice_servers, [{ urls: 'stun:exemplo:3478' }]);
    assert.equal(cf.pedidos.length, 1); // a próxima tentativa só daqui a 1 min
    for (const fim = Date.now() + 2000; !p.log.includes('TURN') && Date.now() < fim;) await wait(20);
    assert.match(p.log, /TURN da Cloudflare indisponível \(HTTP 500\)/);
    assert.ok(!p.log.includes('token-secreto'));
  } finally { cf.srv.close(); }
});

// Ataques que derrubavam o servidor de todos (achados da auditoria). Depois de cada um, ele precisa seguir de pé.
test('mensagens malformadas, frames inválidos, caminho "//" e id gigante não derrubam o servidor', async () => {
  const S = await subir();
  const p = outros.at(-1);
  const ws = S.replace('http', 'ws');
  const fechouCom = (caminho, mandar) => new Promise((res) => {
    const w = new WebSocket(ws + caminho);
    w.onopen = () => mandar(w);
    w.onclose = (e) => res(e.code);
    w.onerror = () => {};
  });
  // conexão crua: handshake na mão e depois bytes quaisquer (o WebSocket do Node não manda UTF-8 inválido)
  const cru = (pedido, depois) => new Promise((res) => {
    const s = net.connect(Number(new URL(S).port), '127.0.0.1', () => s.write(pedido));
    let resposta = '';
    s.on('data', (d) => { resposta += d; if (depois && resposta.includes(' 101 ')) { s.write(depois); depois = null; } });
    s.on('close', () => res(resposta));
    s.on('error', () => res(resposta));
    setTimeout(() => { s.destroy(); res(resposta); }, 2000);
  });
  const upgrade = (caminho) => `GET ${caminho} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`;

  assert.equal(await fechouCom('/gateway', (w) => w.send('null')), 4002);
  assert.equal(await fechouCom('/voice', (w) => w.send('null')), 4002);
  assert.equal(await fechouCom('/gateway', (w) => w.send('[1]')), 4002);
  assert.equal(await fechouCom('/gateway', (w) => w.send('x'.repeat(5000))), 1009); // maior que o maxPayload
  await cru(upgrade('/gateway'), Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe])); // texto com UTF-8 inválido
  assert.match(await cru('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
  await cru(upgrade('//:99999'));
  // logado: um channel_id que não cabe em 64 bits
  const [, conta] = await api('POST', '/register', { username: 'testador', password: 'pudim-de-leite-9' }, null, S);
  const codigo = await new Promise((res) => {
    const w = new WebSocket(ws + '/gateway');
    w.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.op === 10) w.send(JSON.stringify({ op: 2, d: { token: conta.token } }));
      if (m.t === 'READY') w.send(JSON.stringify({ op: 4, d: { guild_id: '1', channel_id: '99999999999999999999' } }));
      if (m.t === 'VOICE_STATE_ERROR') { w.close(1000); res('erro de voz'); }
    };
    w.onclose = () => res('fechou');
  });
  assert.equal(codigo, 'erro de voz');
  assert.equal((await api('GET', '/channels/99999999999999999999/messages', null, conta.token, S))[0], 400);
  // acento cortado entre dois pedaços do corpo: chega inteiro
  const corpo = Buffer.from(JSON.stringify({ username: 'quebrado', password: 'pão-de-queijo-1' }));
  const meio = corpo.indexOf(Buffer.from('ã')) + 1; // no meio dos dois bytes do "ã"
  const partido = await new Promise((res) => {
    const s = net.connect(Number(new URL(S).port), '127.0.0.1', () => {
      s.write(`POST /api/register HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${corpo.length}\r\nConnection: close\r\n\r\n`);
      s.write(corpo.subarray(0, meio));
      setTimeout(() => s.write(corpo.subarray(meio)), 50);
    });
    let r = ''; s.on('data', (d) => { r += d; }); s.on('close', () => res(r));
  });
  assert.match(partido, /HTTP\/1\.1 200/);
  // a senha com "ã" foi gravada inteira: o login com ela funciona (com "��" no lugar, daria 401)
  assert.equal((await api('POST', '/login', { username: 'quebrado', password: 'pão-de-queijo-1' }, null, S))[0], 200);

  assert.equal(p.exitCode, null, `o servidor caiu:\n${p.log}`);
  assert.equal((await api('GET', '/info', null, null, S))[0], 200);
});
