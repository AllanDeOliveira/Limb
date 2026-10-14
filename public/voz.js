// Cliente de voz: gateway de voz (opcodes do Discord) + WebRTC direto entre participantes.
// Fluxo: op 4 no gateway principal → VOICE_SERVER_UPDATE {token, endpoint} → abre o gateway de voz →
// HELLO(8) → IDENTIFY(0) → READY(2, traz os servidores STUN/TURN).
// Negociação "perfeita" (padrão do W3C): qualquer lado pode renegociar a qualquer momento — é o que
// permite ligar e desligar o compartilhamento de tela no meio da chamada. Em colisão, o lado "educado"
// (maior id) cede.

import { TENTA_OUTRO, outrasEntradas, assinaturaPadrao, deveReabrir, alvoSaida, nomeDispositivo, nivelDe } from './dispositivos.js';

// o servidor (voice.js) importa esta mesma tabela
export const VOP = { IDENTIFY: 0, READY: 2, HEARTBEAT: 3, SPEAKING: 5, HEARTBEAT_ACK: 6, HELLO: 8, CLIENTS_CONNECT: 11,
  VIDEO: 12, CLIENT_DISCONNECT: 13, PEER_SIGNAL: 100, STREAM_WATCH: 101 };
const LIMIAR_FALA = 0.02, SEGURA_FALA_MS = 300;
// volume (RMS) do que o analisador ouve agora; buf: Float32Array do tamanho do fftSize
const rmsDe = (an, buf) => { an.getFloatTimeDomainData(buf); return Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length); };

// Preferências de áudio deste computador (não vão para o servidor)
const CHAVE_PREFS = 'limb.audio';
// entradaNome/saidaNome só existem depois de escolher um aparelho; tela (última escolha do Go Live) passa por normalizarTela
const PREFS_PADRAO = { volumeGeral: 1, volumes: {}, entrada: '', saida: '', ruido: true, eco: true, vozKbps: 64 };
function lerPrefs() {
  try { return { ...PREFS_PADRAO, ...JSON.parse(localStorage.getItem(CHAVE_PREFS) ?? '{}') }; } catch { return { ...PREFS_PADRAO }; }
}

// Qualidades do "Go Live": resolução × quadros, como no Discord. Malha P2P: quem transmite envia uma
// cópia para cada pessoa que está assistindo, então o upload é bitrate × quem assiste.
export const RESOLUCOES = ['480', '720', '1080', '1440', 'original'];
export const TAXAS = [15, 30, 60];
const BITRATE_TELA = { // bits/s a 15 / 30 / 60 fps
  480: [800_000, 1_200_000, 2_000_000],
  720: [1_500_000, 2_500_000, 4_000_000],
  1080: [2_700_000, 4_500_000, 7_000_000],
  1440: [4_800_000, 8_000_000, 12_000_000],
};
// Original: escala o 1080p30 pelos pixels e quadros de verdade (crescimento menor que linear, como a tabela)
const bitrateOriginal = (w, h, fps) => Math.round(Math.min(16_000_000, Math.max(800_000,
  4_500_000 * ((w * h) / (1920 * 1080)) ** 0.85 * (fps / 30) ** 0.75)));
const TELA_PADRAO = { resolucao: '1080', fps: 30, otimizar: 'nitidez', codec: '' };
export function normalizarTela(t = {}) {
  return {
    resolucao: RESOLUCOES.includes(String(t.resolucao)) ? String(t.resolucao) : TELA_PADRAO.resolucao,
    fps: TAXAS.includes(Number(t.fps)) ? Number(t.fps) : TELA_PADRAO.fps,
    otimizar: t.otimizar === 'movimento' ? 'movimento' : 'nitidez',
    codec: codecsDeVideo().includes(t.codec) ? t.codec : '',
  };
}
// Upload por pessoa assistindo; no "Original" a tela ainda não foi escolhida: usa o tamanho deste monitor
export function estimativaTela(t) {
  const { resolucao, fps } = normalizarTela(t);
  if (resolucao !== 'original') return BITRATE_TELA[resolucao][TAXAS.indexOf(fps)];
  const dpr = globalThis.devicePixelRatio || 1;
  return bitrateOriginal((globalThis.screen?.width || 1920) * dpr, (globalThis.screen?.height || 1080) * dpr, fps);
}
// Codecs que este navegador codifica e deixa escolher (setCodecPreferences); vazio = só "Automático"
const CODECS = ['H264', 'VP9', 'AV1'];
export function codecsDeVideo() {
  try {
    if (!('setCodecPreferences' in RTCRtpTransceiver.prototype)) return [];
    const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
    return CODECS.filter((c) => caps.some((x) => x.mimeType.toLowerCase() === `video/${c.toLowerCase()}`));
  } catch { return []; }
}
// Primeiro o codec escolhido, depois o resto (rtx/red/ulpfec inclusos) como reserva se o outro lado não tiver.
// A especificação antiga valida pela lista de recepção, a nova pela de envio: tenta as duas; falhou, fica no automático.
function preferirCodec(transceptor, codec) {
  if (!codec || !transceptor.setCodecPreferences) return;
  const mime = `video/${codec}`.toLowerCase();
  for (const lado of [globalThis.RTCRtpReceiver, globalThis.RTCRtpSender]) {
    try {
      const todos = lado?.getCapabilities('video')?.codecs ?? [];
      const escolhido = todos.filter((c) => c.mimeType.toLowerCase() === mime);
      if (!escolhido.length) continue;
      transceptor.setCodecPreferences([...escolhido, ...todos.filter((c) => c.mimeType.toLowerCase() !== mime)]);
      return;
    } catch {}
  }
}

// Voz: o libwebrtc usa o maxBitrate do RTP como alvo do Opus (sem ele, 32 kbps). Padrão do Discord: 64.
const KBPS_VOZ = [32, 64, 96, 128];

// tocar(nome): sons da chamada (sons.js); opcional, para este módulo não depender deles
export function criarClienteVoz({ store, dispatch, enviarGateway, sessionId, tocar = () => {}, avisarErro = console.error }) {
  // setLocalMute do discord_voice.node: silenciar alguém só para mim; vale entre conexões
  const mutadosLocal = new Set();
  let v = null; // conexão atual
  const prefs = lerPrefs();
  const salvarPrefs = () => { try { localStorage.setItem(CHAVE_PREFS, JSON.stringify(prefs)); } catch {} };
  // "ideal", não "exact": microfone escolhido que foi desconectado cai no padrão em vez de falhar
  const restricoes = () => ({
    echoCancellation: prefs.eco, noiseSuppression: prefs.ruido, autoGainControl: true,
    ...(prefs.entrada ? { deviceId: { ideal: prefs.entrada } } : {}),
  });

  const enviar = (op, d) => { if (v?.ws?.readyState === 1) v.ws.send(JSON.stringify({ op, d })); };
  const estado = () => ({ guild_id: v.guildId, channel_id: v.channelId, self_mute: v.mute, self_deaf: v.deaf, self_stream: !!v.tela });
  const avisar = () => dispatch({ type: 'VOICE_LOCAL_UPDATE' });

  let entrando = null; // { canalId, promessa }: clique repetido enquanto o microfone abre não entra duas vezes
  function entrar(canal) {
    if (v?.channelId === canal.id) return Promise.resolve();
    if (entrando?.canalId === canal.id) return entrando.promessa;
    const promessa = entrarAgora(canal).finally(() => { if (entrando?.promessa === promessa) entrando = null; });
    entrando = { canalId: canal.id, promessa };
    return promessa;
  }
  // Sem microfone (não tem, está bloqueado no Windows ou em uso por outro programa): entra só ouvindo,
  // como o Discord, em vez de recusar a chamada. O motivo aparece no painel de voz.
  const MOTIVO_SEM_MIC = {
    NotFoundError: 'Nenhum microfone encontrado.',
    NotAllowedError: 'O Windows bloqueou o microfone (Configurações → Privacidade → Microfone).',
    NotReadableError: 'O microfone está em uso por outro programa.',
  };
  // Tenta o escolhido, depois o padrão do sistema, depois cada um dos outros (ex.: o do notebook quando
  // o fone está ocupado). reserva = abriu outro que não o escolhido.
  async function abrirMicrofone() {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return { stream: new MediaStream(), semMic: 'O navegador só libera o microfone em https ou no app desktop.' };
    let erro = null;
    const abrir = (deviceId) => md.getUserMedia({ audio: { ...restricoes(), deviceId } }).catch((e) => { erro = e; return null; });
    let stream = await abrir(prefs.entrada ? { ideal: prefs.entrada } : undefined), reserva = false;
    if (!stream && prefs.entrada && TENTA_OUTRO.has(erro.name)) reserva = !!(stream = await abrir(undefined));
    if (!stream && TENTA_OUTRO.has(erro.name)) {
      for (const id of outrasEntradas(await listarDispositivos(), [prefs.entrada])) {
        if ((stream = await abrir({ exact: id })) || !TENTA_OUTRO.has(erro.name)) break;
      }
      reserva = !!stream;
    }
    if (!stream) return { stream: new MediaStream(), semMic: MOTIVO_SEM_MIC[erro.name] ?? `Microfone indisponível (${erro.message}).`, erro: erro.name };
    // com "ideal", o Chromium cai sozinho em outro quando o escolhido não está conectado
    if (prefs.entrada && stream.getAudioTracks()[0]?.getSettings().deviceId !== prefs.entrada) reserva = true;
    return { stream, reserva };
  }
  const listarDispositivos = async () => (await navigator.mediaDevices?.enumerateDevices?.().catch(() => null)) ?? [];

  async function entrarAgora(canal) {
    const { stream, semMic, reserva } = await abrirMicrofone();
    if (entrando?.canalId !== canal.id) { stream.getTracks().forEach((t) => t.stop()); return; } // trocou de canal no meio
    // trocar de canal: o op 4 do canal novo já move no servidor (um op 4 null antes derrubaria a conexão nova)
    if (v) { const a = v; v = null; limpar(a); }
    avisoQueda = null; clearTimeout(timerQueda);
    v = { channelId: canal.id, guildId: canal.guild_id, stream, ws: null, status: 'conectando…', ice: [],
      mute: !!semMic, deaf: false, semMic, pares: new Map(), audios: new Map(),
      saida: criarSaida(), // áudio dos outros: cada pessoa → ganho próprio → volume geral → alto-falante
      ganhos: new Map(), // userId → { fonte, ganho }
      tela: null, // minha transmissão: { stream, qualidade }
      telasIds: new Map(), // userId → id do stream de tela que essa pessoa anunciou (op 12)
      telas: new Map(), // userId → MediaStream da tela recebida
      espectadores: new Set(), // quem assiste a minha tela (op 101): só essas conexões recebem o vídeo
      espectadoresDe: new Map(), // userId → ids de quem assiste a tela dessa pessoa ("N assistindo")
      assistindoEnviado: null, // último op 101 que mandei: de quem o servidor acha que eu assisto a tela
      timers: [] };
    detectarFala();
    vigiarFaixa(stream.getAudioTracks()[0]);
    if (reserva) avisoDispositivo(`O microfone escolhido não abriu. Usando: ${micEmUso()}`);
    lembrarPadrao();
    enviarGateway({ op: 4, d: estado() });
    avisar();
  }

  function sair() {
    entrando = null; // desistiu enquanto o microfone abria
    if (!v) return;
    const antigo = v;
    v = null;
    enviarGateway({ op: 4, d: { guild_id: antigo.guildId, channel_id: null } });
    limpar(antigo);
  }
  // Saída por ação minha (botão, sair da conta). Trocar de canal não passa aqui, sem som: só o
  // 'entrar' do canal novo toca, senão os dois se atropelariam
  function sairComSom() { const estava = !!v; sair(); if (estava) tocar('sair'); }

  // A chamada caiu sozinha: linha no #vozAviso em vez de alert() (que travaria a página e o som 'desconectado')
  let avisoQueda = null, timerQueda = 0;
  function avisarQueda(texto) {
    avisoQueda = texto; clearTimeout(timerQueda);
    timerQueda = setTimeout(() => { avisoQueda = null; avisar(); }, 8000);
    avisar();
  }

  function limpar(c) {
    c.timers.forEach(clearInterval);
    c.ws?.close(1000);
    c.pares.forEach((p) => p.pc.close());
    c.audios.forEach((a) => { a.srcObject = null; });
    c.saida.ctx.close().catch(() => {});
    c.stream.getTracks().forEach(soltarFaixa);
    c.tela?.stream.getTracks().forEach((t) => t.stop());
    c.escuta?.stop();
    c.ctx?.close();
    store.speaking.clear();
    if (store.assistindo) store.assistindo = null;
    avisar();
  }

  // Ensurdecer também silencia o microfone; desmutar estando surdo desfaz os dois (igual ao Discord)
  function alternarMudo() {
    if (!v) return;
    if (v.semMic) { // conectou um microfone depois: tenta de novo
      const c = v;
      return reabrirMicrofone().then(() => { if (v === c && !v.semMic) tocar('desmudo'); });
    }
    tocar(v.deaf ? 'dessurdo' : v.mute ? 'desmudo' : 'mudo');
    aplicar(v.deaf ? { mute: false, deaf: false } : { mute: !v.mute });
  }
  function alternarSurdo() {
    if (!v) return;
    tocar(v.deaf ? 'dessurdo' : 'surdo');
    aplicar(v.deaf ? { mute: false, deaf: false } : { mute: true, deaf: true });
  }
  function aplicar(patch) {
    Object.assign(v, patch);
    v.stream.getAudioTracks().forEach((t) => { t.enabled = !v.mute; });
    aplicarGanhos();
    enviarGateway({ op: 4, d: estado() });
    avisar();
  }

  // ── Saída de áudio ────────────────────────────────────────────────────────
  // <audio>.volume para em 100%; o ganho do WebAudio deixa aumentar quem fala baixo (até 200%)
  function criarSaida() {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const geral = ctx.createGain();
    geral.connect(ctx.destination);
    if (prefs.saida && ctx.setSinkId) ctx.setSinkId(prefs.saida).catch(() => {}); // dispositivo sumiu: fica no padrão
    return { ctx, geral };
  }
  function aplicarGanhos() {
    if (!v) return;
    v.saida.geral.gain.value = v.deaf ? 0 : prefs.volumeGeral;
    v.ganhos.forEach(({ ganho }, id) => { ganho.gain.value = mutadosLocal.has(id) ? 0 : (prefs.volumes[id] ?? 1); });
  }

  // Gateway principal mandou o token: abre o gateway de voz
  function servidorPronto(d) {
    if (!v || d.channel_id !== v.channelId) return;
    v.ws?.close(1000);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${d.endpoint}`);
    v.ws = ws;
    ws.onmessage = (e) => receber(JSON.parse(e.data), d).catch((err) => console.error('[voz]', err));
    ws.onclose = (e) => {
      if (v?.ws !== ws) return;
      // 4014 = o servidor tirou do canal (outra aba entrou, ou saiu por lá); demais: falha
      if (e.code !== 4014) { tocar('desconectado'); avisarQueda('Conexão de voz caiu.'); }
      const antigo = v; v = null; limpar(antigo);
      if (e.code !== 4014) enviarGateway({ op: 4, d: { guild_id: antigo.guildId, channel_id: null } });
    };
  }

  async function receber({ op, d }, vsu) {
    if (!v) return;
    switch (op) {
      case VOP.HELLO:
        v.timers.push(setInterval(() => enviar(VOP.HEARTBEAT, { t: Date.now() }), d.heartbeat_interval));
        enviar(VOP.IDENTIFY, { user_id: store.me.id, session_id: sessionId(), token: vsu.token });
        break;
      case VOP.READY:
        v.ice = Array.isArray(d.ice_servers) ? d.ice_servers : [];
        v.assistindoEnviado = null; // sessão de voz nova: o servidor não sabe de nada ainda
        if (v.status !== 'conectado') tocar('entrar');
        v.status = 'conectado';
        sincronizarAssistir();
        avisar();
        break;
      case VOP.CLIENTS_CONNECT: for (const id of d.user_ids) if (id !== store.me.id) par(id); sincronizarAssistir(); break;
      case VOP.CLIENT_DISCONNECT: fecharPar(d.user_id); break;
      case VOP.SPEAKING:
        d.speaking & 1 ? store.speaking.add(d.user_id) : store.speaking.delete(d.user_id);
        avisar();
        break;
      case VOP.VIDEO: // chega antes das faixas da tela (mesmo WebSocket, em ordem)
        if (d.stream_id) {
          if (v.telasIds.get(d.user_id) !== d.stream_id) v.telas.delete(d.user_id); // trocou a qualidade: faixas novas a caminho
          v.telasIds.set(d.user_id, d.stream_id);
          if (Array.isArray(d.viewer_ids)) v.espectadoresDe.set(d.user_id, d.viewer_ids);
        } else {
          v.telasIds.delete(d.user_id); v.telas.delete(d.user_id); v.espectadoresDe.delete(d.user_id);
          if (store.assistindo === d.user_id) store.assistindo = null;
          if (v.assistindoEnviado === d.user_id) { v.assistindoEnviado = null; medirTaxa(null); } // o servidor já zerou
        }
        sincronizarAssistir(); // pediu para assistir antes de saber do stream: manda agora
        avisar();
        break;
      case VOP.STREAM_WATCH: { // alguém começou/parou de assistir a minha tela
        const p = v.pares.get(d.user_id);
        // sem tela, é um pedido que cruzou com o meu "parar" (op 12 null): o servidor já zerou a lista
        if (d.watching) { if (!v.tela) break; v.espectadores.add(d.user_id); if (p && !p.telaSenders.length) enviarTelaPara(p); }
        else { v.espectadores.delete(d.user_id); if (p) tirarTelaDe(p); }
        avisar();
        break;
      }
      case VOP.PEER_SIGNAL: await sinal(d); break;
    }
  }

  // Um RTCPeerConnection por participante. Idempotente: os dois lados chamam ao se verem.
  function par(id) {
    if (v.pares.has(id)) return v.pares.get(id);
    const pc = new RTCPeerConnection({ iceServers: v.ice });
    const p = { pc, educado: BigInt(store.me.id) > BigInt(id), fazendoOferta: false, ignorando: false, telaSenders: [] };
    v.pares.set(id, p);
    if (v.stream.getAudioTracks().length) v.stream.getTracks().forEach((t) => pc.addTrack(t, v.stream));
    else pc.addTransceiver('audio', { direction: 'sendrecv', streams: [v.stream] });
    if (v.tela && v.espectadores.has(id)) enviarTelaPara(p); // a tela só vai para quem assiste
    aplicarParametros(p);
    // antes da primeira negociação o envio pode não ter encodings: aplica de novo a cada uma que termina
    pc.addEventListener('signalingstatechange', () => { if (pc.signalingState === 'stable') aplicarParametros(p); });

    pc.onnegotiationneeded = async () => {
      try {
        p.fazendoOferta = true;
        await pc.setLocalDescription();
        enviar(VOP.PEER_SIGNAL, { to: id, description: pc.localDescription.toJSON() });
      } catch (e) { console.error('[voz] oferta', e); } finally { p.fazendoOferta = false; }
    };
    pc.onicecandidate = (e) => { if (e.candidate) enviar(VOP.PEER_SIGNAL, { to: id, candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce(); // troca de rede/Wi-Fi: tenta de novo
      avisar();
    };
    pc.ontrack = ({ streams: [s] }) => {
      if (!s) return;
      if (s.id === v.telasIds.get(id)) { v.telas.set(id, s); avisar(); return; } // tela: só toca quando alguém assiste
      // O Chromium só entrega áudio remoto do WebRTC ao WebAudio se o stream também estiver num elemento
      // tocando: o <audio> fica mudo e o som sai pelo ganho
      const a = v.audios.get(id) ?? new Audio();
      a.srcObject = s;
      a.muted = true;
      a.play().catch(() => {});
      v.audios.set(id, a);
      v.ganhos.get(id)?.fonte.disconnect();
      const fonte = v.saida.ctx.createMediaStreamSource(s), ganho = v.saida.ctx.createGain();
      fonte.connect(ganho).connect(v.saida.geral);
      v.ganhos.set(id, { fonte, ganho });
      aplicarGanhos();
    };
    return p;
  }

  async function sinal({ from, description, candidate }) {
    const p = par(from);
    const { pc } = p;
    try {
      if (description) {
        const colisao = description.type === 'offer' && (p.fazendoOferta || pc.signalingState !== 'stable');
        p.ignorando = !p.educado && colisao;
        if (p.ignorando) return;
        await pc.setRemoteDescription(description); // educado em colisão: desfaz a própria oferta sozinho
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          enviar(VOP.PEER_SIGNAL, { to: from, description: pc.localDescription.toJSON() });
        }
      } else if (candidate) {
        await pc.addIceCandidate(candidate).catch((e) => { if (!p.ignorando) throw e; });
      }
    } catch (e) { console.error('[voz] sinal', e); }
  }

  function fecharPar(id) {
    v?.pares.get(id)?.pc.close();
    v?.pares.delete(id);
    const a = v?.audios.get(id);
    if (a) { a.srcObject = null; v.audios.delete(id); }
    v?.ganhos.get(id)?.fonte.disconnect();
    v?.ganhos.delete(id);
    v?.telas.delete(id);
    v?.telasIds.delete(id);
    v?.espectadores.delete(id);
    v?.espectadoresDe.delete(id);
    if (v?.assistindoEnviado === id) { v.assistindoEnviado = null; medirTaxa(null); }
    if (store.assistindo === id) store.assistindo = null;
    store.speaking.delete(id);
    avisar();
  }

  // ── Compartilhar tela ─────────────────────────────────────────────────────
  // fonte: no app desktop, o id escolhido no seletor próprio; no navegador, o seletor nativo do Chrome.
  // escolha: { resolucao, fps, otimizar, codec } (ver normalizarTela); fica guardada para a próxima vez.
  async function compartilharTela({ comAudio = false, ...escolha } = {}) {
    if (!v) return;
    const cfg = normalizarTela(escolha);
    prefs.tela = cfg; salvarPrefs();
    const altura = cfg.resolucao === 'original' ? null : Number(cfg.resolucao);
    // max: não amplia uma tela menor que a resolução escolhida, nem passa dos quadros escolhidos
    const restr = { frameRate: { ideal: cfg.fps, max: cfg.fps }, ...(altura && { height: { ideal: altura, max: altura } }) };
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: restr, audio: comAudio });
    const conexao = v;
    const descartar = () => stream.getTracks().forEach((t) => t.stop());
    if (!conexao) return descartar(); // saiu da voz enquanto escolhia
    const [video] = stream.getVideoTracks();
    // Nitidez (texto/código): mantém a resolução e cai o fps; Movimento (jogo/vídeo): o contrário
    video.contentHint = cfg.otimizar === 'movimento' ? 'motion' : 'detail';
    await video.applyConstraints(restr).catch(() => {});
    if (v !== conexao || video.readyState === 'ended') return descartar();
    const s = video.getSettings();
    const bitrate = altura ? BITRATE_TELA[altura][TAXAS.indexOf(cfg.fps)]
      : bitrateOriginal(s.width || 1920, s.height || 1080, Math.min(cfg.fps, s.frameRate || cfg.fps));
    video.onended = pararTela; // "Parar de compartilhar" do sistema
    // Trocou a qualidade no meio: quem assiste continua assistindo (o servidor mantém a lista), só as faixas mudam
    if (v.tela) {
      v.tela.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      for (const p of v.pares.values()) tirarTelaDe(p);
    }
    v.tela = { stream, qualidade: { ...cfg, altura, bitrate, nome: `${altura ? `${altura}p` : 'Original'} · ${cfg.fps} fps` } };
    enviar(VOP.VIDEO, { stream_id: stream.id }); // antes das faixas: quem recebe já sabe que é tela
    for (const id of v.espectadores) { const p = v.pares.get(id); if (p) enviarTelaPara(p); }
    enviarGateway({ op: 4, d: estado() });
    avisar();
  }

  function enviarTelaPara(p) {
    const { stream, qualidade: q } = v.tela;
    p.telaSenders = stream.getTracks().map((t) => {
      const tr = p.pc.addTransceiver(t, {
        direction: 'sendonly', streams: [stream],
        sendEncodings: t.kind === 'video' ? [{ maxBitrate: q.bitrate, maxFramerate: q.fps }] : undefined,
      });
      if (t.kind === 'video') preferirCodec(tr, q.codec); // antes da oferta: o negotiationneeded vem depois
      return tr.sender;
    });
    aplicarParametros(p);
  }
  // stop(), não removeTrack: a linha vira rejeitada (porta 0) e o Chromium a reaproveita no próximo
  // addTransceiver. Com removeTrack, cada assistir/parar somaria uma linha inteira no SDP até passar do
  // limite do gateway de voz (64 KB) e derrubar a chamada.
  function tirarTelaDe(p) {
    if (p.pc.signalingState !== 'closed') {
      for (const tr of p.pc.getTransceivers()) if (p.telaSenders.includes(tr.sender)) try { tr.stop(); } catch {}
    }
    p.telaSenders = [];
  }

  // Parâmetros de envio: getParameters → setParameters sem await no meio. Navegador sem suporte: ignora.
  async function ajustarEnvio(sender, mudar) {
    if (!sender?.getParameters) return;
    try {
      const par = sender.getParameters();
      if (!par.encodings?.length) return; // ainda não negociou: tenta de novo quando terminar
      mudar(par);
      await sender.setParameters(par);
    } catch {}
  }
  // o lugar do microfone é o primeiro transceptor de áudio que não é da tela (existe mesmo só ouvindo)
  const senderMic = (p) => p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio' && !p.telaSenders.includes(t.sender))?.sender;
  const kbpsVoz = () => (KBPS_VOZ.includes(prefs.vozKbps) ? prefs.vozKbps : PREFS_PADRAO.vozKbps);
  function aplicarParametros(p) {
    if (!v || p.pc.signalingState === 'closed') return;
    // voz com prioridade alta: com a internet apertada, a tela perde qualidade antes da voz
    ajustarEnvio(senderMic(p), (par) => Object.assign(par.encodings[0], { maxBitrate: kbpsVoz() * 1000, priority: 'high', networkPriority: 'high' }));
    const tela = p.telaSenders.find((s) => s.track?.kind === 'video');
    const pref = v.tela?.qualidade.otimizar === 'movimento' ? 'maintain-framerate' : 'maintain-resolution';
    if (tela) ajustarEnvio(tela, (par) => { par.degradationPreference = pref; });
  }

  // Quem assiste o quê: store.assistindo muda em vários lugares (palco no app.js, saídas aqui). Um ponto só
  // compara com o último op 101 mandado; roda no render e quando a voz ou um stream fica pronto, então
  // pedir para assistir antes da conexão de voz terminar também chega ao servidor.
  function sincronizarAssistir() {
    if (v?.status !== 'conectado' || v.ws?.readyState !== 1) return; // antes do READY o servidor não aceita nada
    const quem = store.assistindo;
    const alvo = quem && quem !== store.me?.id && v.telasIds.has(quem) ? quem : null; // a minha prévia não usa a rede
    if (alvo === v.assistindoEnviado) return;
    if (v.assistindoEnviado) {
      enviar(VOP.STREAM_WATCH, { user_id: v.assistindoEnviado, watching: false });
      v.telas.delete(v.assistindoEnviado); // ao voltar a assistir, as faixas chegam de novo
    }
    if (alvo) enviar(VOP.STREAM_WATCH, { user_id: alvo, watching: true });
    v.assistindoEnviado = alvo;
    medirTaxa(alvo);
  }

  // Taxa recebida da tela assistida (bytes de vídeo do inbound-rtp, a cada ~1 s); para quando para de assistir
  function medirTaxa(alvo) {
    if (!v) return;
    clearInterval(v.medidor);
    v.timers = v.timers.filter((t) => t !== v.medidor);
    v.medidor = null; v.taxa = null;
    if (!alvo) return;
    const c = v;
    let antes = null;
    c.medidor = setInterval(async () => {
      const pc = c.pares.get(alvo)?.pc;
      const rel = pc && await pc.getStats().catch(() => null);
      if (!rel || v !== c || c.assistindoEnviado !== alvo) return;
      let bytes = 0;
      rel.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') bytes += s.bytesReceived ?? 0; });
      const agora = performance.now();
      if (antes && bytes >= antes.bytes) { c.taxa = ((bytes - antes.bytes) * 8000) / (agora - antes.agora); avisar(); }
      antes = { bytes, agora };
    }, 1000);
    c.timers.push(c.medidor);
  }

  function pararTela() {
    if (!v?.tela) return;
    v.tela.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    for (const p of v.pares.values()) tirarTelaDe(p);
    v.espectadores.clear(); // o op 12 sem stream zera a lista no servidor também
    v.tela = null;
    if (store.assistindo === store.me.id) store.assistindo = null;
    enviar(VOP.VIDEO, { stream_id: null });
    enviarGateway({ op: 4, d: estado() });
    avisar();
  }

  // Indicador de fala: volume (RMS) do microfone; muda o estado só depois de SEGURA_FALA_MS
  function detectarFala() {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {}); // criado depois de um await: pode nascer suspenso
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    v.ctx = ctx;
    v.analisador = an;
    escutarMicrofone();
    const amostra = new Float32Array(an.fftSize);
    let falando = false, ultimaVoz = 0;
    v.timers.push(setInterval(() => {
      const rms = rmsDe(an, amostra);
      if (rms > LIMIAR_FALA && !v.mute) ultimaVoz = Date.now();
      // setOnSpeakingWhileMutedCallback: falando com o microfone desligado → aviso no painel
      const mudoFalando = v.mute && !v.deaf && rms > LIMIAR_FALA;
      if (mudoFalando) v.mudoFalandoAte = Date.now() + 1500;
      const aviso = Date.now() < (v.mudoFalandoAte ?? 0);
      if (aviso !== !!v.avisoMudo) { v.avisoMudo = aviso; avisar(); }
      const agora = Date.now() - ultimaVoz < SEGURA_FALA_MS;
      if (agora === falando) return;
      falando = agora;
      enviar(VOP.SPEAKING, { speaking: falando ? 1 : 0 });
      falando ? store.speaking.add(store.me.id) : store.speaking.delete(store.me.id);
      avisar();
    }, 100));
  }

  // Analisa um clone: mudo desativa a faixa enviada, e faixa desativada entrega silêncio —
  // sem o clone, "falando enquanto mudo" nunca dispararia
  function escutarMicrofone() {
    v.fonteEscuta?.disconnect();
    v.escuta?.stop();
    const [faixa] = v.stream.getAudioTracks();
    if (!faixa) { v.escuta = null; return; } // só ouvindo: nada para analisar
    v.escuta = faixa.clone();
    v.escuta.enabled = true; // o clone herda o "desativado" do mudo: trocar de microfone mudo calaria o aviso
    v.fonteEscuta = v.ctx.createMediaStreamSource(new MediaStream([v.escuta]));
    v.fonteEscuta.connect(v.analisador);
  }

  // Trocar microfone ou processamento no meio da chamada: abre o novo e troca a faixa em cada conexão,
  // sem renegociar (replaceTrack). Uma troca por vez: pedidos no meio (devicechange, faixa que acabou,
  // clique) viram uma repetição só. auto = troca que a pessoa não pediu (aparelho entrou ou saiu).
  let reabrindo = null, pedido = null;
  function reabrirMicrofone(auto = false) {
    if (!v) return Promise.resolve();
    pedido = { auto: auto === true && (pedido?.auto ?? true) }; // um pedido manual no meio vale como manual
    reabrindo ??= (async () => {
      try {
        while (pedido && v) {
          const { auto: a } = pedido;
          pedido = null;
          await trocarMicrofone(a).catch((e) => console.error('[voz] microfone', e));
        }
      } finally { reabrindo = null; pedido = null; }
    })();
    return reabrindo;
  }

  async function trocarMicrofone(auto) {
    const conexao = v;
    const { stream: novo, semMic, reserva } = await abrirMicrofone();
    if (v !== conexao) { novo.getTracks().forEach((t) => t.stop()); return; } // saiu da voz enquanto abria
    const [velha] = v.stream.getAudioTracks(), eraSemMic = !!v.semMic;
    const viva = velha?.readyState === 'live';
    if (semMic) {
      if (viva) { avisoDispositivo(`Não foi possível trocar o microfone: ${semMic}`); return; } // fica no que funciona
      // perdeu o microfone e nenhum outro abriu: só ouvindo até aparecer um (devicechange)
      if (!eraSemMic) { v.mudoAntes = v.mute; v.mute = true; }
      v.semMic = semMic;
      v.stream.getTracks().forEach(soltarFaixa);
      v.stream = new MediaStream();
      escutarMicrofone();
      enviarGateway({ op: 4, d: estado() });
      avisar();
      await trocarFaixa(conexao, null);
      return;
    }
    const [faixa] = novo.getAudioTracks();
    // devicechange sem mudança de verdade (ex.: o escolhido voltou, mas segue ocupado): fica com o que já está aberto
    if (auto && viva && faixa.label === velha.label && faixa.getSettings().deviceId === velha.getSettings().deviceId) {
      novo.getTracks().forEach((t) => t.stop());
      return;
    }
    if (eraSemMic) {
      v.semMic = null;
      if (auto) v.mute = v.deaf || !!v.mudoAntes; // voltou o microfone: fica como estava antes de perder
      else { v.mute = false; if (v.deaf) { v.deaf = false; aplicarGanhos(); } } // clicou no microfone: quer falar
      v.mudoAntes = null;
    }
    faixa.enabled = !v.mute;
    await trocarFaixa(conexao, faixa);
    if (v !== conexao) { novo.getTracks().forEach((t) => t.stop()); return; }
    faixa.enabled = !v.mute; // mudo/desmudo durante a troca
    const antes = velha?.label;
    v.stream.getTracks().forEach(soltarFaixa);
    v.stream = novo;
    // quem conectou durante a troca nasceu com a faixa velha (ou sem nenhuma): troca nele também
    v.pares.forEach((p) => { const s = senderMic(p); if (s && s.track !== faixa) s.replaceTrack(faixa).catch(() => {}); });
    v.pares.forEach((p) => aplicarParametros(p)); // a qualidade da voz vale para o microfone novo também
    vigiarFaixa(faixa);
    escutarMicrofone();
    lembrarPadrao();
    if (auto && eraSemMic) avisoDispositivo(`Microfone conectado: ${micEmUso()}`);
    else if (auto && faixa.label !== antes) avisoDispositivo(`Microfone trocado para: ${micEmUso()}`);
    else if (!auto && reserva) avisoDispositivo(`O microfone escolhido não abriu. Usando: ${micEmUso()}`);
    enviarGateway({ op: 4, d: estado() });
    avisar();
  }

  const trocarFaixa = (c, faixa) => Promise.allSettled([...c.pares.values()].map((p) => senderMic(p)?.replaceTrack(faixa)));
  const micEmUso = () => { const f = v?.stream.getAudioTracks()[0]; return f?.readyState === 'live' ? nomeDispositivo(f.label) || 'Microfone' : null; };

  // Fone desconectado (ou driver reiniciado): a faixa acaba sem aviso e a chamada ficaria muda
  function aoAcabarFaixa(e) { if (v && v.stream.getAudioTracks()[0] === e.target) reabrirMicrofone(true); }
  const vigiarFaixa = (f) => f?.addEventListener('ended', aoAcabarFaixa);
  const soltarFaixa = (f) => { f.removeEventListener('ended', aoAcabarFaixa); f.stop(); };

  // Linha curta no painel de voz depois de uma troca que a pessoa não pediu; some sozinha
  function avisoDispositivo(texto) {
    const c = v;
    if (!c) return;
    const aviso = (c.avisoDisp = { texto });
    // limpar() cancela com clearInterval: setTimeout e setInterval dividem os mesmos ids
    c.timers.push(setTimeout(() => { if (c.avisoDisp === aviso) { c.avisoDisp = null; avisar(); } }, 6000));
    avisar();
  }

  // ── Aparelhos entrando e saindo (um ouvinte só, para a vida toda do cliente) ──
  let ultimoPadrao = null, timerDispositivos = 0;
  const lembrarPadrao = () => listarDispositivos().then((l) => { ultimoPadrao = assinaturaPadrao(l); });
  async function verificarDispositivos() {
    const lista = await listarDispositivos();
    const padraoAntes = ultimoPadrao;
    ultimoPadrao = assinaturaPadrao(lista);
    teste?.reiniciar(); // fora da chamada, o teste reabre e segue o aparelho novo
    if (!v) return;
    seguirSaida(lista);
    const [faixa] = v.stream.getAudioTracks();
    if (deveReabrir({ lista, semMic: !!v.semMic, bloqueado: v.semMic === MOTIVO_SEM_MIC.NotAllowedError, faixaViva: faixa?.readyState === 'live',
      idAtual: faixa?.getSettings().deviceId, escolhido: prefs.entrada, padraoAntes, padraoAgora: ultimoPadrao })) reabrirMicrofone(true);
  }
  // o Windows manda vários devicechange seguidos por aparelho: espera assentar
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    clearTimeout(timerDispositivos);
    timerDispositivos = setTimeout(() => verificarDispositivos().catch((e) => console.error('[voz] dispositivos', e)), 500);
  });
  lembrarPadrao();

  // Saída escolhida desconectada: toca no padrão do sistema e volta para ela quando reaparece
  function seguirSaida(lista) {
    const ctx = v.saida.ctx;
    if (!prefs.saida || !ctx.setSinkId || typeof ctx.sinkId !== 'string') return;
    const alvo = alvoSaida(lista, prefs.saida);
    if (ctx.sinkId === alvo) return;
    ctx.setSinkId(alvo).then(() => ctx.resume()).catch(() => {});
    avisoDispositivo(alvo ? 'Saída de áudio reconectada.' : 'Saída de áudio desconectada: tocando no padrão do sistema.');
  }

  // Teste do microfone (página "Voz e áudio"): na chamada lê o mesmo analisador do indicador de fala;
  // fora dela abre o microfone só para o teste. aoNivel recebe { nivel (0–100), fala, microfone, erro }.
  let teste = null;
  function testarMicrofone(aoNivel) {
    teste?.parar();
    let temp = null, abrindo = false, geracao = 0, pico = 0;
    const amostra = new Float32Array(512);
    const fecharTemp = () => { geracao++; temp?.stream?.getTracks().forEach((t) => t.stop()); temp?.ctx?.close().catch(() => {}); temp = null; };
    async function abrirTemp() {
      const g = geracao;
      abrindo = true;
      const r = await abrirMicrofone();
      abrindo = false;
      if (teste !== este || v || g !== geracao) { r.stream.getTracks().forEach((t) => t.stop()); return; } // parou, entrou na voz ou trocou o aparelho
      if (r.semMic) { temp = { erro: r.semMic }; return; }
      const ctx = new AudioContext(), an = ctx.createAnalyser();
      ctx.resume().catch(() => {});
      an.fftSize = amostra.length;
      ctx.createMediaStreamSource(r.stream).connect(an);
      temp = { stream: r.stream, ctx, an };
    }
    const timer = setInterval(() => {
      if (v || temp?.stream?.getAudioTracks()[0]?.readyState === 'ended') { if (temp) fecharTemp(); } // na chamada usa o dela
      else if (!temp && !abrindo) abrirTemp();
      const an = v ? v.analisador : temp?.an;
      const rms = an ? rmsDe(an, amostra) : 0;
      pico = Math.max(nivelDe(rms), pico * 0.8); // sobe na hora, desce devagar
      const f = v ? v.stream.getAudioTracks()[0] : temp?.stream?.getAudioTracks()[0];
      aoNivel({ nivel: pico, fala: rms > LIMIAR_FALA, microfone: f?.readyState === 'live' ? nomeDispositivo(f.label) || 'Microfone' : null,
        erro: (v ? v.semMic : temp?.erro) ?? null });
    }, 50);
    const este = {
      parar() { clearInterval(timer); fecharTemp(); if (teste === este) teste = null; },
      reiniciar() { if (!v && temp) fecharTemp(); else if (abrindo) geracao++; },
    };
    teste = este;
    return este.parar;
  }

  function alternarMutoLocal(userId) {
    mutadosLocal.has(userId) ? mutadosLocal.delete(userId) : mutadosLocal.add(userId);
    aplicarGanhos();
    avisar();
  }

  // ── Ajustes (página "Voz e áudio" e volume por pessoa) ─────────────────────
  const ajustes = {
    prefs: () => ({ ...prefs, volumes: { ...prefs.volumes } }),
    volumeDe: (userId) => prefs.volumes[userId] ?? 1,
    definirVolume(userId, valor) {
      const x = Math.min(2, Math.max(0, Number(valor) || 0));
      if (x === 1) delete prefs.volumes[userId]; else prefs.volumes[userId] = x; // 100% não precisa ficar salvo
      salvarPrefs(); aplicarGanhos(); avisar();
    },
    definirVolumeGeral(valor) { prefs.volumeGeral = Math.min(1, Math.max(0, Number(valor) || 0)); salvarPrefs(); aplicarGanhos(); },
    async definirSaida(id, nome) {
      prefs.saida = String(id ?? ''); if (nome) prefs.saidaNome = nome; salvarPrefs();
      if (v?.saida.ctx.setSinkId) await v.saida.ctx.setSinkId(prefs.saida).catch((e) => avisarErro(`Não foi possível usar essa saída: ${e.message}`));
    },
    // nome: para o <select> mostrar "Fone X (desconectado)" quando ele sumir
    async definirEntrada(id, nome) { prefs.entrada = String(id ?? ''); if (nome) prefs.entradaNome = nome; salvarPrefs(); teste?.reiniciar(); await reabrirMicrofone().catch((e) => avisarErro(`Não foi possível usar esse microfone: ${e.message}`)); },
    async definirProcessamento({ ruido, eco }) {
      if (ruido != null) prefs.ruido = !!ruido;
      if (eco != null) prefs.eco = !!eco;
      salvarPrefs(); teste?.reiniciar();
      await reabrirMicrofone().catch(() => {});
    },
    testarMicrofone,
    limiarNivel: nivelDe(LIMIAR_FALA), // onde fica a marca de "aparece falando" na barra do teste
    escolheSaida: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    tela: () => normalizarTela(prefs.tela), // última escolha do "Compartilhar tela"
    qualidadeVoz: kbpsVoz,
    // vale na hora para todas as conexões (sem renegociar)
    definirQualidadeVoz(kbps) {
      if (!KBPS_VOZ.includes(Number(kbps))) return;
      prefs.vozKbps = Number(kbps); salvarPrefs();
      v?.pares.forEach((p) => aplicarParametros(p));
    },
  };

  return {
    entrar, sair: sairComSom, alternarMudo, alternarSurdo, servidorPronto, alternarMutoLocal, compartilharTela, pararTela, ajustes,
    sincronizarAssistir,
    mutadoLocal: (userId) => mutadosLocal.has(userId),
    // quantos assistem a tela de alguém (a minha: quem o servidor disse pelo op 101)
    espectadores: (userId) => (!v ? 0 : userId === store.me?.id ? v.espectadores.size : v.espectadoresDe.get(userId)?.length ?? 0),
    taxaRecebida: (userId) => (v && v.assistindoEnviado === userId ? v.taxa : null), // bits/s; null = ainda medindo
    // tela de alguém (ou a minha, como prévia) para o palco; null se não houver
    tela: (userId) => (userId === store.me?.id ? v?.tela?.stream : v?.telas.get(userId)) ?? null,
    surdo: () => !!v?.deaf,
    avisoQueda: () => avisoQueda, // "Conexão de voz caiu." por alguns segundos, já fora da chamada
    atual: () => v && { channelId: v.channelId, status: v.status, mute: v.mute, deaf: v.deaf, avisoMudo: !!v.avisoMudo, semMic: v.semMic ?? null,
      microfone: micEmUso(), avisoDispositivo: v.avisoDisp?.texto ?? null, // microfone: nome do que está em uso (null só ouvindo)
      transmitindo: !!v.tela, qualidade: v.tela?.qualidade.nome, espectadores: v.tela ? v.espectadores.size : 0,
      conectados: [...v.pares.values()].filter((p) => p.pc.connectionState === 'connected').length },
    // nova sessão no gateway principal (READY, não RESUMED): a voz antiga não vale mais
    resetar: () => { if (v) { const a = v; v = null; limpar(a); } },
  };
}
