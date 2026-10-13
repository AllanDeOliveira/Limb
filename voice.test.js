// Gateway de voz sem rede: sockets falsos guardam o que o servidor manda. Cobre o op 101 STREAM_WATCH
// (a tela só vai para quem assiste) — o caminho de ponta a ponta do op 4/IDENTIFY está no server.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { criarVoz, VOP } from './voice.js';

function montar() {
  const principal = []; // eventos do gateway principal (VOICE_SERVER_UPDATE etc.)
  const voz = criarVoz({
    broadcast: () => {},
    paraSessao: (s, t, d) => principal.push({ s, t, d }),
    canalDeVoz: (id) => (id === 'sala' || id === 'outra' ? { id, guild_id: 'g' } : null),
  });
  // entra no canal (op 4) e conecta o gateway de voz com o token recebido
  const entrar = (userId, canal = 'sala') => {
    const sessao = { id: `s-${userId}`, user: { id: userId } };
    voz.atualizarEstado(sessao, { channel_id: canal });
    const { token } = principal.findLast((x) => x.s === sessao).d;
    const ws = Object.assign(new EventEmitter(), { readyState: 1, ev: [], fechado: null });
    ws.send = (raw) => ws.ev.push(JSON.parse(raw));
    ws.close = (code) => { ws.fechado = code; ws.readyState = 3; ws.emit('close'); };
    ws.mandar = (op, d) => ws.emit('message', JSON.stringify({ op, d }));
    ws.de = (op) => ws.ev.filter((p) => p.op === op).map((p) => p.d);
    voz.gatewayVoz(ws);
    ws.mandar(VOP.IDENTIFY, { server_id: 'g', user_id: userId, session_id: sessao.id, token });
    assert.ok(ws.de(VOP.READY).length, `${userId} conectou`);
    return { ws, sessao, sair: () => voz.atualizarEstado(sessao, { channel_id: null }) };
  };
  return { voz, entrar };
}

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
