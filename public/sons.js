// Sons da chamada, como os do Discord, sintetizados na hora com WebAudio: nada de arquivo de áudio.
// Cada som é uma lista de notas (oscilador + envelope de volume); nenhum passa de ~450 ms.
// Nada de window/document/localStorage no topo do módulo: o teste importa este arquivo no Node.

const CHAVE = 'limb.sons';
const PADRAO = { ligado: true, volume: 0.6, categorias: { chamada: true, audio: true, transmissao: true, mencao: true } };
// Ganho no volume máximo. Medido no Chrome: pico de ~-16 dBFS no padrão (60%) e ~-6 dBFS em 100% —
// audível no alto-falante do notebook sem abafar a voz de ninguém
const PICO = 0.9;
const OCIOSO_MS = 30_000; // tanto tempo sem som: fecha o AudioContext (libera o dispositivo de saída)
const VELHO_MS = 1500; // som que só conseguiria tocar depois disso (aba sem clique ainda) já perdeu o sentido

// Afinação temperada, Lá 440
const RE4 = 293.66, FA4 = 349.23, LA4 = 440, MI5 = 659.26, SOL5 = 783.99, SOLS5 = 830.61, RE5 = 587.33,
  LA5 = 880, SI5 = 987.77, RE6 = 1174.66, MI6 = 1318.51;

// Nota: f = frequência (Hz), ate = desliza até essa frequência em `desliza` s, t = início (s), d = duração (s),
// g = ganho (0–1), onda = forma de onda (seno se omitida), segura = tempo no pico antes de decair (s)
const tri = (n) => ({ onda: 'triangle', ...n });
// fundamental + oitava que some antes: timbre de sininho, para a menção não parecer um aviso da chamada
const sino = (f, t, d, g) => [{ f, t, d, g, ataque: 0.003 }, { f: f * 2, t, d: d * 0.5, g: g * 0.2, ataque: 0.003 }];

const SONS = {
  // Eu: quinta justa subindo/descendo em onda triangular, com um brilho de oitava na chegada
  entrar: { categoria: 'chamada', filtro: { f: 3800 }, notas: [
    tri({ f: RE5, t: 0, d: 0.16, g: 0.5, segura: 0.04 }),
    tri({ f: LA5, t: 0.09, d: 0.25, g: 0.5, segura: 0.05 }),
    { f: LA5 * 2, t: 0.09, d: 0.14, g: 0.06 }] },
  sair: { categoria: 'chamada', filtro: { f: 3800 }, notas: [
    tri({ f: LA5, t: 0, d: 0.16, g: 0.5, segura: 0.04 }),
    tri({ f: RE5, t: 0.09, d: 0.25, g: 0.5, segura: 0.05 })] },
  // Os outros: mais baixo, seno puro e terça maior, cada nota com um "bloop" curto na frente
  outroEntrou: { categoria: 'chamada', filtro: { f: 2400 }, notas: [
    { f: MI5 * 0.94, ate: MI5, desliza: 0.03, t: 0, d: 0.12, g: 0.38 },
    { f: SOLS5 * 0.94, ate: SOLS5, desliza: 0.03, t: 0.075, d: 0.2, g: 0.38 }] },
  outroSaiu: { categoria: 'chamada', filtro: { f: 2400 }, notas: [
    { f: SOLS5 * 1.06, ate: SOLS5, desliza: 0.03, t: 0, d: 0.12, g: 0.38 },
    { f: MI5 * 1.06, ate: MI5, desliza: 0.03, t: 0.075, d: 0.2, g: 0.38 }] },
  // Microfone: um "bwoop" só, deslizando (as notas separadas ficam para entrar/sair)
  mudo: { categoria: 'audio', filtro: { f: 2400 }, notas: [tri({ f: 740, ate: 440, desliza: 0.09, t: 0, d: 0.14, g: 0.5, segura: 0.03 })] },
  desmudo: { categoria: 'audio', filtro: { f: 2400 }, notas: [tri({ f: 440, ate: 740, desliza: 0.09, t: 0, d: 0.14, g: 0.5, segura: 0.03 })] },
  // Áudio: mais grave, e o filtro fecha (som "abafando") ou abre junto
  surdo: { categoria: 'audio', filtro: { f: 2600, ate: 500, d: 0.28 }, notas: [
    tri({ f: RE5, ate: 330, desliza: 0.12, t: 0, d: 0.16, g: 0.5, segura: 0.03 }),
    tri({ f: RE4, t: 0.1, d: 0.2, g: 0.4 })] },
  dessurdo: { categoria: 'audio', filtro: { f: 500, ate: 2600, d: 0.25 }, notas: [
    tri({ f: RE4, t: 0, d: 0.12, g: 0.4 }),
    tri({ f: 330, ate: RE5, desliza: 0.12, t: 0.07, d: 0.2, g: 0.5, segura: 0.03 })] },
  // Transmissão: arpejo rápido de três notas (Sol maior), mais agudo que entrar/sair
  transmissaoInicio: { categoria: 'transmissao', filtro: { f: 4200 }, notas: [
    tri({ f: SOL5, t: 0, d: 0.1, g: 0.4 }), tri({ f: SI5, t: 0.065, d: 0.1, g: 0.4 }),
    tri({ f: RE6, t: 0.13, d: 0.24, g: 0.42, segura: 0.04 }), { f: RE6 * 2, t: 0.13, d: 0.12, g: 0.05 }] },
  transmissaoFim: { categoria: 'transmissao', filtro: { f: 4200 }, notas: [
    tri({ f: RE6, t: 0, d: 0.1, g: 0.4 }), tri({ f: SI5, t: 0.065, d: 0.1, g: 0.4 }),
    tri({ f: SOL5, t: 0.13, d: 0.24, g: 0.42, segura: 0.04 })] },
  mencao: { categoria: 'mencao', notas: [...sino(SI5, 0, 0.2, 0.4), ...sino(MI6, 0.085, 0.32, 0.4)] },
  // Caiu: tríade menor descendo, grave e abafada — dá para reconhecer sem olhar a tela
  desconectado: { categoria: 'chamada', filtro: { f: 1800 }, notas: [
    tri({ f: LA4, t: 0, d: 0.15, g: 0.5, segura: 0.04 }), tri({ f: FA4, t: 0.12, d: 0.15, g: 0.5, segura: 0.04 }),
    tri({ f: RE4, t: 0.24, d: 0.2, g: 0.5, segura: 0.05 })] },
};
export const NOMES = Object.keys(SONS);

const limitar = (x, padrao) => (Number.isFinite(Number(x)) && x !== '' && x != null ? Math.min(1, Math.max(0, Number(x))) : padrao);
function normalizar(salvo) {
  const s = salvo && typeof salvo === 'object' ? salvo : {};
  const categorias = { ...PADRAO.categorias };
  for (const k of Object.keys(categorias)) if (typeof s.categorias?.[k] === 'boolean') categorias[k] = s.categorias[k];
  return { ligado: typeof s.ligado === 'boolean' ? s.ligado : PADRAO.ligado, volume: limitar(s.volume, PADRAO.volume), categorias };
}

// saida(): id do alto-falante escolhido em "Voz e áudio" ('' = padrão do sistema).
// AudioContext/armazenamento podem ser trocados no teste; no navegador vêm do próprio window.
export function criarSons({ saida = () => '', AudioContext: AC = globalThis.AudioContext, armazenamento } = {}) {
  const guarda = () => { try { return armazenamento ?? globalThis.localStorage ?? null; } catch { return null; } };
  let cfg;
  try { cfg = normalizar(JSON.parse(guarda()?.getItem(CHAVE) ?? 'null')); } catch { cfg = normalizar(null); }
  const salvar = () => { try { guarda()?.setItem(CHAVE, JSON.stringify(cfg)); } catch {} };

  let ctx = null, sink = '', fimAgendado = 0, timerOcioso = null;
  let preparo = null; // promessa de setSinkId/resume ainda pendente
  const ultimo = new Map(); // nome → quando tocou: rajada de eventos iguais (ex.: RESUME) vira um som só

  // Um AudioContext só, criado no primeiro som e reaproveitado; fecha quando fica ocioso
  function contexto() {
    if (ctx) return ctx;
    if (typeof AC !== 'function') return null;
    try { ctx = new AC(); } catch { return null; }
    sink = ''; fimAgendado = 0; preparo = null; // contexto novo: dispositivo padrão e relógio do zero
    return ctx;
  }
  function vigiarOcioso() {
    clearTimeout(timerOcioso);
    timerOcioso = setTimeout(() => {
      const c = ctx;
      if (!c) return;
      if (c.state === 'running' && c.currentTime < fimAgendado + 1) return vigiarOcioso(); // ainda tocando
      ctx = null;
      c.close?.().catch(() => {});
    }, OCIOSO_MS);
    timerOcioso.unref?.(); // Node (teste): não segura o processo
  }
  // Política de autoplay do navegador: contexto criado antes do primeiro clique nasce suspenso
  const destravar = () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); };
  globalThis.addEventListener?.('pointerdown', destravar, { capture: true, passive: true });
  globalThis.addEventListener?.('keydown', destravar, { capture: true, passive: true });

  function nota(c, destino, t0, n) {
    const osc = c.createOscillator(), env = c.createGain();
    const ataque = n.ataque ?? 0.012, pico = t0 + ataque + (n.segura ?? 0), fim = t0 + n.d;
    osc.type = n.onda ?? 'sine';
    osc.frequency.setValueAtTime(n.f, t0);
    if (n.ate) osc.frequency.exponentialRampToValueAtTime(n.ate, t0 + (n.desliza ?? n.d));
    // começa e termina em zero: sem estalo
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(n.g, t0 + ataque);
    env.gain.setValueAtTime(n.g, pico);
    env.gain.exponentialRampToValueAtTime(0.0001, fim);
    env.gain.linearRampToValueAtTime(0, fim + 0.005);
    osc.connect(env).connect(destino);
    osc.start(t0);
    osc.stop(fim + 0.01);
    return { osc, env, fim: fim + 0.01 };
  }

  function agendar(c, som, atraso) {
    const t = c.currentTime + 0.02 + atraso; // folga: agendar "agora" pode cair no passado e cortar o ataque
    const barramento = c.createGain();
    barramento.gain.setValueAtTime(PICO * cfg.volume ** 2, t); // ao quadrado: o controle soa linear ao ouvido
    barramento.connect(c.destination);
    let entrada = barramento, filtro = null;
    if (som.filtro) {
      filtro = c.createBiquadFilter();
      filtro.type = 'lowpass';
      filtro.Q.setValueAtTime(som.filtro.q ?? 0.7, t);
      filtro.frequency.setValueAtTime(som.filtro.f, t);
      if (som.filtro.ate) filtro.frequency.exponentialRampToValueAtTime(som.filtro.ate, t + som.filtro.d);
      filtro.connect(barramento);
      entrada = filtro;
    }
    const notas = som.notas.map((n) => nota(c, entrada, t + n.t, n));
    let faltam = notas.length;
    for (const { osc, env } of notas) osc.onended = () => {
      osc.disconnect(); env.disconnect();
      if (--faltam === 0) { filtro?.disconnect(); barramento.disconnect(); }
    };
    fimAgendado = Math.max(fimAgendado, ...notas.map((n) => n.fim));
    vigiarOcioso();
  }

  // opcoes.forcar: toca mesmo com o som desligado (botão "Testar"); opcoes.atraso em segundos.
  // Nunca lança: quem chama (mudo, sair da chamada) segue em frente mesmo se o áudio falhar.
  function tocar(nome, opcoes) {
    try { return tocarAgora(nome, opcoes); } catch (e) { console.warn('[sons]', e); return false; }
  }
  function tocarAgora(nome, { forcar = false, atraso = 0 } = {}) {
    const som = Object.hasOwn(SONS, nome) ? SONS[nome] : null;
    if (!som || cfg.volume <= 0 || (!forcar && (!cfg.ligado || !cfg.categorias[som.categoria]))) return false;
    const agora = Date.now();
    if (!forcar && agora - (ultimo.get(nome) ?? -Infinity) < 80) return false;
    ultimo.set(nome, agora);
    const c = contexto();
    if (!c) return false;
    clearTimeout(timerOcioso); // não fecha enquanto este som espera o dispositivo
    const espera = [];
    let destino = '';
    try { destino = String(saida() ?? ''); } catch {}
    if (destino !== sink && typeof c.setSinkId === 'function') {
      sink = destino;
      // saída escolhida sumiu (fone desconectado): volta para o padrão em silêncio; sink = '' faz o próximo som
      // tentar a escolhida de novo, senão ficaria no padrão mesmo depois de o fone voltar
      espera.push(c.setSinkId(destino).catch(() => { sink = ''; return c.setSinkId('').catch(() => {}); }));
    }
    if (c.state !== 'running') espera.push(c.resume());
    if (preparo) espera.push(preparo); // troca de saída em andamento: o som seguinte espera junto, na ordem
    if (!espera.length) { agendar(c, som, atraso); return true; }
    const p = preparo = Promise.all(espera).finally(() => { if (preparo === p) preparo = null; });
    p.then(() => {
      if (c !== ctx) return;
      if (c.state === 'running' && Date.now() - agora < VELHO_MS) agendar(c, som, atraso); else vigiarOcioso();
    }).catch(() => {});
    return true;
  }

  return {
    tocar,
    config: () => ({ ...cfg, categorias: { ...cfg.categorias } }),
    definir(patch = {}) {
      if (patch.ligado != null) cfg.ligado = !!patch.ligado;
      if (patch.volume != null) cfg.volume = limitar(patch.volume, cfg.volume);
      for (const [k, x] of Object.entries(patch.categorias ?? {})) if (Object.hasOwn(cfg.categorias, k)) cfg.categorias[k] = !!x;
      salvar();
    },
    // entrar e, logo depois, sair: o par que mais toca, no volume escolhido
    testar() { tocar('entrar', { forcar: true }); tocar('sair', { forcar: true, atraso: 0.55 }); },
  };
}
