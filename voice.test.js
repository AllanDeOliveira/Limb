// Gateway de voz sem rede: sockets falsos guardam o que o servidor manda. Cobre o op 101 STREAM_WATCH
// (a tela só vai para quem assiste) e a lista de ICE do READY — o caminho de ponta a ponta do op 4/IDENTIFY
// está no server.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { criarVoz, VOP } from './voice.js';

function montar(opcoes = {}) {
  const principal = []; // eventos do gateway principal (VOICE_SERVER_UPDATE etc.)
  const voz = criarVoz({
    broadcast: () => {},
    paraSessao: (s, t, d) => principal.push({ s, t, d }),
    canalDeVoz: (id) => (id === 'sala' || id === 'outra' ? { id, guild_id: 'g' } : null),
    ...opcoes,
  });
  // entra no canal (op 4): devolve o token que o gateway principal mandou
  const pedirToken = (userId, canal = 'sala', sessaoId = `s-${userId}`) => {
    const sessao = { id: sessaoId, user: { id: userId } };
    voz.atualizarEstado(sessao, { channel_id: canal });
    return { sessao, token: principal.findLast((x) => x.s === sessao).d.token };
  };
  // conecta o gateway de voz com o token recebido
  const usarToken = ({ sessao, token }) => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, ev: [], fechado: null });
    ws.send = (raw) => ws.ev.push(JSON.parse(raw));
    ws.close = (code) => { ws.fechado = code; ws.readyState = 3; ws.emit('close'); };
    ws.mandar = (op, d) => ws.emit('message', JSON.stringify({ op, d }));
    ws.de = (op) => ws.ev.filter((p) => p.op === op).map((p) => p.d);
    voz.gatewayVoz(ws);
    ws.mandar(VOP.IDENTIFY, { server_id: 'g', user_id: sessao.user.id, session_id: sessao.id, token });
    return { ws, sessao, sair: () => voz.atualizarEstado(sessao, { channel_id: null }) };
  };
  const conectar = (userId, canal) => usarToken(pedirToken(userId, canal));
  const entrar = (userId, canal) => {
    const c = conectar(userId, canal);
    assert.ok(c.ws.de(VOP.READY).length, `${userId} conectou`);
    return c;
  };
  return { voz, entrar, conectar, pedirToken, usarToken };
}
const microtarefas = () => new Promise(setImmediate);

test('ice_servers a cada READY: função; Promise segura o READY; quem sai no meio não entra', async () => {
  let pendente = null, liberar;
  const { entrar, conectar } = montar({ iceServers: () => pendente ?? [{ urls: 'stun:fixo' }] });
  const ana = entrar('1');
  assert.deepEqual(ana.ws.de(VOP.READY)[0].ice_servers, [{ urls: 'stun:fixo' }]);

  // credenciais do TURN ainda chegando: nada de READY, e ninguém na sala vê a bia antes dele
  pendente = new Promise((r) => { liberar = r; });
  const bia = conectar('2');
  bia.ws.mandar(VOP.SPEAKING, { speaking: 1 }); // antes do READY: ignorado, sem derrubar
  assert.deepEqual(bia.ws.de(VOP.READY), []);
  assert.equal(ana.ws.de(VOP.CLIENTS_CONNECT).length, 1);
  liberar([{ urls: 'turn:x', username: 'u', credential: 'c' }]);
  await microtarefas();
  assert.equal(bia.ws.fechado, null);
  assert.deepEqual(bia.ws.de(VOP.READY)[0].ice_servers, [{ urls: 'turn:x', username: 'u', credential: 'c' }]);
  assert.deepEqual(bia.ws.de(VOP.CLIENTS_CONNECT)[0].user_ids, ['1']);
  assert.deepEqual(ana.ws.de(VOP.CLIENTS_CONNECT).at(-1).user_ids, ['2']);

  // saiu do canal enquanto esperava: fecha com 4014 e nunca aparece para os outros
  pendente = new Promise((r) => { liberar = r; });
  const caio = conectar('3');
  caio.sair();
  liberar([]);
  await microtarefas();
  assert.deepEqual(caio.ws.de(VOP.READY), []);
  assert.equal(caio.ws.fechado, 4014);
  assert.deepEqual(ana.ws.de(VOP.CLIENTS_CONNECT).at(-1).user_ids, ['2']);

  // a Promise falhou: entra assim mesmo, com a lista vazia
  pendente = Promise.reject(new Error('fora do ar'));
  const dani = conectar('4');
  await microtarefas();
  assert.deepEqual(dani.ws.de(VOP.READY)[0].ice_servers, []);
});

test('token ainda não usado de outra aba não tira da sala quem entrou depois', () => {
  const { pedirToken, usarToken } = montar();
  const doPc = pedirToken('1', 'sala', 's-pc');
  // antes de o PC conectar a voz, a mesma pessoa entra pelo celular (outra sessão, mesmo canal)
  const celular = usarToken(pedirToken('1', 'sala', 's-celular'));
  assert.ok(celular.ws.de(VOP.READY).length);
  const pc = usarToken(doPc);
  assert.equal(pc.ws.fechado, 4004);
  assert.equal(celular.ws.fechado, null);
});

test('op 101: só quem transmite recebe, com o id carimbado; sala recebe a lista', () => {
  const { entrar } = montar();
  const ana = entrar('1'), bia = entrar('2'), caio = entrar('3');
  // ninguém transmitindo: ignorado
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  assert.deepEqual(ana.ws.de(VOP.STREAM_WATCH), []);

  ana.ws.mandar(VOP.VIDEO, { stream_id: '{tela}' });
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true, from: 'forjado' });
  assert.deepEqual(ana.ws.de(VOP.STREAM_WATCH), [{ user_id: '2', watching: true }]);
  assert.deepEqual(caio.ws.de(VOP.STREAM_WATCH), []); // não vaza para os outros
  assert.deepEqual(bia.ws.de(VOP.STREAM_WATCH), []);
  assert.deepEqual(caio.ws.de(VOP.VIDEO).at(-1), { user_id: '1', stream_id: '{tela}', viewer_ids: ['2'] });
  assert.deepEqual(bia.ws.de(VOP.VIDEO).at(-1), { user_id: '1', stream_id: '{tela}', viewer_ids: ['2'] });

  // repetido não é repassado (renegociaria à toa); assistir a si mesmo e alvo inexistente são ignorados
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  ana.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  caio.ws.mandar(VOP.STREAM_WATCH, { user_id: '99', watching: true });
  assert.equal(ana.ws.de(VOP.STREAM_WATCH).length, 1);

  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: false });
  assert.deepEqual(ana.ws.de(VOP.STREAM_WATCH).at(-1), { user_id: '2', watching: false });
  assert.deepEqual(caio.ws.de(VOP.VIDEO).at(-1).viewer_ids, []);
});

test('op 101: alvo em outro canal é ignorado', () => {
  const { entrar } = montar();
  const ana = entrar('1'), dani = entrar('4', 'outra');
  ana.ws.mandar(VOP.VIDEO, { stream_id: '{tela}' });
  dani.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  assert.deepEqual(ana.ws.de(VOP.STREAM_WATCH), []);
});

test('quem assiste sai da sala: sai da lista e quem transmite é avisado', () => {
  const { entrar } = montar();
  const ana = entrar('1'), bia = entrar('2'), caio = entrar('3');
  ana.ws.mandar(VOP.VIDEO, { stream_id: '{tela}' });
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  caio.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  bia.sair();
  assert.equal(bia.ws.fechado, 4014);
  assert.deepEqual(ana.ws.de(VOP.STREAM_WATCH).at(-1), { user_id: '2', watching: false });
  assert.deepEqual(caio.ws.de(VOP.VIDEO).at(-1).viewer_ids, ['3']);
  // a queda do gateway de voz (sem op 4) também limpa
  caio.ws.close(1006);
  assert.deepEqual(ana.ws.de(VOP.STREAM_WATCH).at(-1), { user_id: '3', watching: false });
});

test('trocar o stream mantém quem assiste; parar zera; quem chega recebe o estado atual', () => {
  const { entrar } = montar();
  const ana = entrar('1'), bia = entrar('2');
  ana.ws.mandar(VOP.VIDEO, { stream_id: '{tela}' });
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  ana.ws.mandar(VOP.VIDEO, { stream_id: '{tela-2}' }); // trocou a qualidade no meio

  const caio = entrar('3');
  const iVideo = caio.ws.ev.findIndex((p) => p.op === VOP.VIDEO), iConn = caio.ws.ev.findIndex((p) => p.op === VOP.CLIENTS_CONNECT);
  assert.ok(iVideo >= 0 && iVideo < iConn);
  assert.deepEqual(caio.ws.ev[iVideo].d, { user_id: '1', stream_id: '{tela-2}', viewer_ids: ['2'] });

  ana.ws.mandar(VOP.VIDEO, { stream_id: null }); // parou
  assert.deepEqual(caio.ws.de(VOP.VIDEO).at(-1), { user_id: '1', stream_id: null });
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: false }); // já foi zerado: nada a avisar
  assert.equal(ana.ws.de(VOP.STREAM_WATCH).length, 1);
  const dani = entrar('4');
  assert.deepEqual(dani.ws.de(VOP.VIDEO), []);

  // transmitindo de novo, sem ninguém assistindo: quem chega recebe só o stream
  ana.ws.mandar(VOP.VIDEO, { stream_id: '{tela-3}' });
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: true });
  assert.deepEqual(ana.ws.de(VOP.STREAM_WATCH).at(-1), { user_id: '2', watching: true });
  // quem transmite sai: a lista vai junto e quem assistia recebe CLIENT_DISCONNECT
  ana.sair();
  assert.deepEqual(bia.ws.de(VOP.CLIENT_DISCONNECT).at(-1), { user_id: '1' });
  bia.ws.mandar(VOP.STREAM_WATCH, { user_id: '1', watching: false }); // atrasado: ignorado sem erro
  const ana2 = entrar('1');
  assert.deepEqual(ana2.ws.de(VOP.STREAM_WATCH), []);
});
