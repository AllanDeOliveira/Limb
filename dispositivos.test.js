import test from 'node:test';
import assert from 'node:assert/strict';
import { nomeDispositivo, assinaturaPadrao, outrasEntradas, deveReabrir, alvoSaida, opcoesDispositivos, nivelDe } from './public/dispositivos.js';

// Como o Chromium lista no Windows: apelidos 'default' e 'communications' + os aparelhos de verdade
const mic = (deviceId, label, groupId = deviceId) => ({ kind: 'audioinput', deviceId, label, groupId });
const sai = (deviceId, label, groupId = deviceId) => ({ kind: 'audiooutput', deviceId, label, groupId });
const fone = mic('fone', 'Microfone (Headset USB)', 'g-fone'), note = mic('note', 'Microfone (Realtek Audio)', 'g-note');
const lista = [mic('default', 'Padrão - Microfone (Headset USB)', 'g-fone'), mic('communications', 'Comunicações - Microfone (Headset USB)', 'g-fone'),
  fone, note, sai('default', 'Padrão - Alto-falantes (Realtek Audio)', 'g-note'), sai('caixa', 'Alto-falantes (Realtek Audio)', 'g-note')];
const semPermissao = [{ kind: 'audioinput', deviceId: '', label: '', groupId: '' }, { kind: 'audiooutput', deviceId: '', label: '', groupId: '' }];

test('nome: tira o prefixo do apelido de padrão', () => {
  assert.equal(nomeDispositivo('Padrão - Microfone (Realtek Audio)'), 'Microfone (Realtek Audio)');
  assert.equal(nomeDispositivo('Default - Microphone (USB)'), 'Microphone (USB)');
  assert.equal(nomeDispositivo('Microfone - Fone'), 'Microfone - Fone');
  assert.equal(nomeDispositivo(undefined), '');
});

test('padrão do sistema: muda quando o Windows troca o padrão; sem permissão não compara', () => {
  const antes = assinaturaPadrao(lista);
  const depois = assinaturaPadrao([mic('default', 'Padrão - Microfone (Realtek Audio)', 'g-note'), note]);
  assert.ok(antes && depois && antes !== depois);
  assert.equal(assinaturaPadrao(semPermissao), null);
  assert.equal(assinaturaPadrao([note, fone]), 'g-note|Microfone (Realtek Audio)'); // Firefox: o primeiro é o padrão
});

test('reserva: tenta os outros microfones, sem apelidos e sem repetir', () => {
  assert.deepEqual(outrasEntradas(lista, ['fone']), ['note']);
  assert.deepEqual(outrasEntradas(lista, ['']), ['fone', 'note']);
  assert.deepEqual(outrasEntradas(semPermissao), []);
});

test('devicechange: quando reabrir o microfone', () => {
  const base = { lista, semMic: false, bloqueado: false, faixaViva: true, idAtual: 'default', escolhido: '', padraoAntes: 'a', padraoAgora: 'a' };
  assert.equal(deveReabrir(base), false); // nada mudou
  assert.equal(deveReabrir({ ...base, faixaViva: false }), true); // desconectou
  assert.equal(deveReabrir({ ...base, padraoAgora: 'b' }), true); // padrão do sistema mudou
  assert.equal(deveReabrir({ ...base, padraoAntes: null, padraoAgora: 'b' }), false); // só ganhou permissão
  assert.equal(deveReabrir({ ...base, escolhido: 'fone', idAtual: 'note' }), true); // o escolhido voltou
  assert.equal(deveReabrir({ ...base, escolhido: 'sumiu', idAtual: 'note' }), false); // segue na reserva
  assert.equal(deveReabrir({ ...base, escolhido: 'fone', idAtual: 'fone', padraoAgora: 'b' }), false); // escolhido não segue o padrão
  assert.equal(deveReabrir({ ...base, semMic: true }), true); // só ouvindo e tem microfone
  assert.equal(deveReabrir({ ...base, semMic: true, lista: semPermissao }), true); // aparece mesmo sem permissão
  assert.equal(deveReabrir({ ...base, semMic: true, lista: [sai('caixa', 'x')] }), false);
  assert.equal(deveReabrir({ ...base, semMic: true, bloqueado: true }), false);
});

test('saída: a escolhida se conectada, senão o padrão', () => {
  assert.equal(alvoSaida(lista, 'caixa'), 'caixa');
  assert.equal(alvoSaida(lista, 'fone-bt'), '');
  assert.equal(alvoSaida(lista, 'fone'), ''); // id de microfone não vale como saída
  assert.equal(alvoSaida(lista, ''), '');
});

test('opções: padrão com o nome de verdade e escolhido desconectado continua na lista', () => {
  const op = opcoesDispositivos(lista, 'audioinput', 'note');
  assert.deepEqual(op.map((o) => o.value), ['', 'fone', 'note']);
  assert.equal(op[0].nome, 'Padrão do sistema — Microfone (Headset USB)');
  assert.deepEqual(op.filter((o) => o.selected).map((o) => o.value), ['note']);
  const sumiu = opcoesDispositivos(lista, 'audioinput', 'bt', 'Fone Bluetooth');
  assert.equal(sumiu.at(-1).nome, 'Fone Bluetooth (desconectado)');
  assert.ok(sumiu.at(-1).selected && !sumiu[0].selected);
  const cego = opcoesDispositivos(semPermissao, 'audioinput', 'bt', 'Fone Bluetooth');
  assert.deepEqual(cego.map((o) => o.nome), ['Padrão do sistema', 'Fone Bluetooth']); // sem permissão não dá para dizer que sumiu
  assert.equal(opcoesDispositivos(lista, 'audiooutput', '')[0].selected, true);
});

test('nível: escala em dB, a marca de fala fica no meio da barra', () => {
  assert.equal(nivelDe(0), 0);
  assert.equal(nivelDe(1), 100);
  assert.equal(nivelDe(0.001), 0);
  const limiar = nivelDe(0.02);
  assert.ok(limiar > 35 && limiar < 50, String(limiar));
});
