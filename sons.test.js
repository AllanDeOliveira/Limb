import test from 'node:test';
import assert from 'node:assert/strict';
import { criarSons, NOMES } from './public/sons.js';

// AudioContext de mentira: guarda o que foi agendado e reclama do que o WebAudio de verdade recusaria
class Param {
  constructor() { this.eventos = []; }
  setValueAtTime(v, t) { this.eventos.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v, t) { this.eventos.push(['lin', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) {
    if (!(v > 0)) throw new RangeError('rampa exponencial precisa de valor positivo');
    this.eventos.push(['exp', v, t]); return this;
  }
}
class No {
  constructor(ctx, tipo) { this.ctx = ctx; this.tipo = tipo; this.saidas = []; ctx.nos.push(this); }
  connect(n) { this.saidas.push(n); return n; }
  disconnect() { this.saidas = []; }
}
class CtxFalso {
  static criados = [];
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = { tipo: 'destino' }; this.nos = []; this.sinks = []; CtxFalso.criados.push(this); }
  createOscillator() { const n = new No(this, 'osc'); n.frequency = new Param(); n.start = (t) => { n.inicio = t; }; n.stop = (t) => { n.fim = t; }; return n; }
  createGain() { const n = new No(this, 'ganho'); n.gain = new Param(); return n; }
  createBiquadFilter() { const n = new No(this, 'filtro'); n.frequency = new Param(); n.Q = new Param(); return n; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  setSinkId(id) { this.sinks.push(id); return Promise.resolve(); }
  osciladores() { return this.nos.filter((n) => n.tipo === 'osc'); }
}
const memoria = (inicial = {}) => {
  const m = new Map(Object.entries(inicial));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
};
const novo = (extra = {}) => {
  CtxFalso.criados = [];
  return criarSons({ AudioContext: CtxFalso, armazenamento: memoria(), ...extra });
};
// chega no alto-falante? segue as conexões a partir do nó
const chegaNoDestino = (n, ctx) => n === ctx.destination || n.saidas?.some((s) => chegaNoDestino(s, ctx));

test('sons: cada nome agenda notas curtas, sem estalo, ligadas ao alto-falante', () => {
  assert.ok(NOMES.length >= 12);
  for (const nome of ['entrar', 'sair', 'outroEntrou', 'outroSaiu', 'mudo', 'desmudo', 'surdo', 'dessurdo',
    'transmissaoInicio', 'transmissaoFim', 'mencao', 'desconectado']) assert.ok(NOMES.includes(nome), nome);
  for (const nome of NOMES) {
    const sons = novo();
    assert.equal(sons.tocar(nome), true, nome);
    const [ctx] = CtxFalso.criados;
    const osc = ctx.osciladores();
    assert.ok(osc.length > 0, `${nome}: nenhuma nota`);
    const inicio = Math.min(...osc.map((o) => o.inicio));
    for (const o of osc) {
      assert.ok(o.fim - inicio <= 0.47, `${nome}: passa de ~450 ms (${o.fim - inicio})`);
      assert.ok(chegaNoDestino(o, ctx), `${nome}: nota solta`);
      const [env] = o.saidas;
      assert.deepEqual(env.gain.eventos[0].slice(0, 2), ['set', 0], `${nome}: envelope não começa em zero`);
      assert.equal(env.gain.eventos.at(-1)[1], 0, `${nome}: envelope não termina em zero`);
      assert.ok(env.gain.eventos.every(([, v]) => v <= 1), `${nome}: ganho acima de 1`);
    }
  }
});

test('sons: nome desconhecido, som desligado e categoria desligada não tocam nada', () => {
  let sons = novo();
  assert.equal(sons.tocar('naoExiste'), false);
  assert.equal(sons.tocar('toString'), false); // nada herdado do Object
  assert.equal(CtxFalso.criados.length, 0);

  sons = novo();
  sons.definir({ ligado: false });
  for (const nome of NOMES) assert.equal(sons.tocar(nome), false, nome);
  assert.equal(CtxFalso.criados.reduce((n, c) => n + c.osciladores().length, 0), 0);

  sons = novo();
  sons.definir({ categorias: { audio: false } });
  for (const nome of ['mudo', 'desmudo', 'surdo', 'dessurdo']) assert.equal(sons.tocar(nome), false, nome);
  assert.equal(CtxFalso.criados.reduce((n, c) => n + c.osciladores().length, 0), 0);
  assert.equal(sons.tocar('entrar'), true); // as outras categorias continuam

  sons = novo();
  sons.definir({ volume: 0 });
  assert.equal(sons.tocar('entrar'), false);
});

test('sons: "Testar" toca entrar e sair mesmo com o som desligado', async () => {
  for (const saida of ['', 'fone-1']) { // com saída escolhida, os dois esperam o setSinkId, na ordem
    const sons = novo({ saida: () => saida });
    sons.definir({ ligado: false });
    sons.testar();
    await new Promise((r) => setTimeout(r, 0));
    const [ctx] = CtxFalso.criados;
    const inicios = ctx.osciladores().map((o) => o.inicio);
    assert.ok(inicios.length >= 4, saida);
    assert.ok(Math.max(...inicios) - Math.min(...inicios) >= 0.5, saida); // sair vem depois, não por cima
  }
});

test('sons: ajustes salvos em limb.sons e validados ao ler', () => {
  const guarda = memoria();
  const a = criarSons({ AudioContext: CtxFalso, armazenamento: guarda });
  assert.deepEqual(a.config(), { ligado: true, volume: 0.6, categorias: { chamada: true, audio: true, transmissao: true, mencao: true } });
  a.definir({ volume: '0.35', categorias: { mencao: false, inventada: true } });
  const b = criarSons({ AudioContext: CtxFalso, armazenamento: guarda });
  assert.equal(b.config().volume, 0.35);
  assert.equal(b.config().categorias.mencao, false);
  assert.ok(!('inventada' in b.config().categorias));
  a.definir({ volume: 7 });
  assert.equal(a.config().volume, 1);

  for (const lixo of ['{', '"x"', JSON.stringify({ ligado: 'sim', volume: 'alto', categorias: { chamada: 1 } })]) {
    const c = criarSons({ AudioContext: CtxFalso, armazenamento: memoria({ 'limb.sons': lixo }) });
    assert.deepEqual(c.config(), { ligado: true, volume: 0.6, categorias: { chamada: true, audio: true, transmissao: true, mencao: true } });
  }
  // sem localStorage (ou bloqueado): funciona com o padrão
  const quebrado = { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } };
  const d = criarSons({ AudioContext: CtxFalso, armazenamento: quebrado });
  d.definir({ ligado: false });
  assert.equal(d.config().ligado, false);
});

test('sons: um AudioContext só, na saída escolhida, e nada sem WebAudio', async () => {
  let saida = 'fone-1';
  const sons = novo({ saida: () => saida });
  sons.tocar('entrar');
  await new Promise((r) => setTimeout(r, 0)); // espera o setSinkId
  sons.tocar('mencao');
  assert.equal(CtxFalso.criados.length, 1);
  const [ctx] = CtxFalso.criados;
  assert.deepEqual(ctx.sinks, ['fone-1']); // só troca quando muda
  assert.ok(ctx.osciladores().length > 0);
  saida = '';
  sons.tocar('sair');
  assert.deepEqual(ctx.sinks, ['fone-1', '']);

  const semAudio = criarSons({ AudioContext: undefined, armazenamento: memoria() });
  assert.equal(semAudio.tocar('entrar'), false);
});

test('sons: contexto suspenso (autoplay) toca ao destravar logo, mas não um som que ficou velho', async (t) => {
  let destravar;
  class Suspenso extends CtxFalso {
    constructor() { super(); this.state = 'suspended'; }
    resume() { return new Promise((ok) => { destravar = () => { this.state = 'running'; ok(); }; }); }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let sons = criarSons({ AudioContext: Suspenso, armazenamento: memoria() });
  sons.tocar('entrar');
  destravar(); await tick();
  assert.ok(CtxFalso.criados.at(-1).osciladores().length > 0);

  sons = criarSons({ AudioContext: Suspenso, armazenamento: memoria() });
  assert.equal(sons.tocar('mencao'), true);
  await tick();
  assert.equal(CtxFalso.criados.at(-1).osciladores().length, 0); // esperando o clique
  const agora = Date.now();
  t.mock.method(Date, 'now', () => agora + 5000); // o clique só veio 5 s depois
  destravar(); await tick();
  assert.equal(CtxFalso.criados.at(-1).osciladores().length, 0);
});
