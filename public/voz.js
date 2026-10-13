// Cliente de voz: gateway de voz (opcodes do Discord) + WebRTC direto entre participantes.
// Fluxo: op 4 no gateway principal → VOICE_SERVER_UPDATE {token, endpoint} → abre o gateway de voz →
// HELLO(8) → IDENTIFY(0) → READY(2, traz os servidores STUN/TURN) → SELECT_PROTOCOL(1) → SESSION_DESCRIPTION(4).
// Negociação "perfeita" (padrão do W3C): qualquer lado pode renegociar a qualquer momento — é o que
// permite ligar e desligar o compartilhamento de tela no meio da chamada. Em colisão, o lado "educado"
// (maior id) cede.

const VOP = { IDENTIFY: 0, SELECT_PROTOCOL: 1, READY: 2, HEARTBEAT: 3, SESSION_DESCRIPTION: 4, SPEAKING: 5,
  HEARTBEAT_ACK: 6, HELLO: 8, CLIENTS_CONNECT: 11, VIDEO: 12, CLIENT_DISCONNECT: 13, PEER_SIGNAL: 100 };
const LIMIAR_FALA = 0.02, SEGURA_FALA_MS = 300;

// Preferências de áudio deste computador (não vão para o servidor)
const CHAVE_PREFS = 'limb.audio';
const PREFS_PADRAO = { volumeGeral: 1, volumes: {}, entrada: '', saida: '', ruido: true, eco: true };
function lerPrefs() {
  try { return { ...PREFS_PADRAO, ...JSON.parse(localStorage.getItem(CHAVE_PREFS) ?? '{}') }; } catch { return { ...PREFS_PADRAO }; }
}

// Qualidades do "Go Live". Malha P2P: quem transmite envia uma cópia para cada pessoa na sala.
export const QUALIDADES = {
  '720p30': { altura: 720, fps: 30, bitrate: 2_500_000, nome: '720p · 30 fps' },
  '1080p30': { altura: 1080, fps: 30, bitrate: 4_500_000, nome: '1080p · 30 fps' },
  '1080p60': { altura: 1080, fps: 60, bitrate: 7_000_000, nome: '1080p · 60 fps' },
};

export function criarClienteVoz({ store, dispatch, enviarGateway, sessionId }) {
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
  async function abrirMicrofone() {
    try { return { stream: await navigator.mediaDevices.getUserMedia({ audio: restricoes() }) }; }
    catch (e) { return { stream: new MediaStream(), semMic: MOTIVO_SEM_MIC[e.name] ?? `Microfone indisponível (${e.message}).` }; }
  }

  async function entrarAgora(canal) {
    const { stream, semMic } = await abrirMicrofone();
    if (entrando?.canalId !== canal.id) { stream.getTracks().forEach((t) => t.stop()); return; } // trocou de canal no meio
    if (v) sair();
    v = { channelId: canal.id, guildId: canal.guild_id, stream, ws: null, ssrc: 0, status: 'conectando…', ice: [],
      mute: !!semMic, deaf: false, semMic, pares: new Map(), audios: new Map(),
      saida: criarSaida(), // áudio dos outros: cada pessoa → ganho próprio → volume geral → alto-falante
      ganhos: new Map(), // userId → { fonte, ganho }
      tela: null, // minha transmissão: { stream, qualidade }
      telasIds: new Map(), // userId → id do stream de tela que essa pessoa anunciou (op 12)
      telas: new Map(), // userId → MediaStream da tela recebida
      timers: [] };
    detectarFala();
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

  function limpar(c) {
    c.timers.forEach(clearInterval);
    c.ws?.close(1000);
    c.pares.forEach((p) => p.pc.close());
    c.audios.forEach((a) => { a.srcObject = null; });
    c.saida.ctx.close().catch(() => {});
    c.stream.getTracks().forEach((t) => t.stop());
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
    if (v.semMic) return reabrirMicrofone(); // conectou um microfone depois: tenta de novo
    aplicar(v.deaf ? { mute: false, deaf: false } : { mute: !v.mute });
  }
  function alternarSurdo() { if (v) aplicar(v.deaf ? { mute: false, deaf: false } : { mute: true, deaf: true }); }
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
      if (e.code !== 4014) alert('Conexão de voz caiu');
      const antigo = v; v = null; limpar(antigo);
      if (e.code !== 4014) enviarGateway({ op: 4, d: { guild_id: antigo.guildId, channel_id: null } });
    };
  }

  async function receber({ op, d }, vsu) {
    if (!v) return;
    switch (op) {
      case VOP.HELLO:
        v.timers.push(setInterval(() => enviar(VOP.HEARTBEAT, { t: Date.now() }), d.heartbeat_interval));
        enviar(VOP.IDENTIFY, { server_id: vsu.guild_id, user_id: store.me.id, session_id: sessionId(), token: vsu.token });
        break;
      case VOP.READY:
        v.ssrc = d.ssrc;
        v.ice = Array.isArray(d.ice_servers) ? d.ice_servers : [];
        enviar(VOP.SELECT_PROTOCOL, { protocol: 'webrtc-p2p', data: null });
        break;
      case VOP.SESSION_DESCRIPTION: v.status = 'conectado'; avisar(); break;
      case VOP.CLIENTS_CONNECT: for (const id of d.user_ids) if (id !== store.me.id) par(id); break;
      case VOP.CLIENT_DISCONNECT: fecharPar(d.user_id); break;
      case VOP.SPEAKING:
        d.speaking & 1 ? store.speaking.add(d.user_id) : store.speaking.delete(d.user_id);
        avisar();
        break;
      case VOP.VIDEO: // chega antes das faixas da tela (mesmo WebSocket, em ordem)
        if (d.stream_id) v.telasIds.set(d.user_id, d.stream_id);
        else { v.telasIds.delete(d.user_id); v.telas.delete(d.user_id); if (store.assistindo === d.user_id) store.assistindo = null; }
        avisar();
        break;
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
    if (v.tela) enviarTelaPara(p);

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
    if (store.assistindo === id) store.assistindo = null;
    store.speaking.delete(id);
    avisar();
  }

  // ── Compartilhar tela ─────────────────────────────────────────────────────
  // fonte: no app desktop, o id escolhido no seletor próprio; no navegador, o seletor nativo do Chrome.
  async function compartilharTela({ qualidade = '1080p30', comAudio = false } = {}) {
    if (!v) return;
    const q = QUALIDADES[qualidade] ?? QUALIDADES['1080p30'];
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { height: { ideal: q.altura }, frameRate: { ideal: q.fps } },
      audio: comAudio,
    });
    if (!v) { stream.getTracks().forEach((t) => t.stop()); return; } // saiu da voz enquanto escolhia
    const [video] = stream.getVideoTracks();
    video.contentHint = q.fps >= 60 ? 'motion' : 'detail'; // jogo: fluidez; texto/código: nitidez
    await video.applyConstraints({ height: { ideal: q.altura }, frameRate: { ideal: q.fps } }).catch(() => {});
    video.onended = pararTela; // "Parar de compartilhar" do sistema
    if (v.tela) pararTela();
    v.tela = { stream, qualidade: q };
    enviar(VOP.VIDEO, { stream_id: stream.id }); // antes das faixas: quem recebe já sabe que é tela
    for (const p of v.pares.values()) enviarTelaPara(p);
    enviarGateway({ op: 4, d: estado() });
    avisar();
  }

  function enviarTelaPara(p) {
    const { stream, qualidade } = v.tela;
    p.telaSenders = stream.getTracks().map((t) => p.pc.addTransceiver(t, {
      direction: 'sendonly', streams: [stream],
      sendEncodings: t.kind === 'video' ? [{ maxBitrate: qualidade.bitrate, maxFramerate: qualidade.fps }] : undefined,
    }).sender);
  }

  function pararTela() {
    if (!v?.tela) return;
    v.tela.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    for (const p of v.pares.values()) {
      for (const s of p.telaSenders) if (p.pc.signalingState !== 'closed') p.pc.removeTrack(s);
      p.telaSenders = [];
    }
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
      an.getFloatTimeDomainData(amostra);
      const rms = Math.sqrt(amostra.reduce((s, x) => s + x * x, 0) / amostra.length);
      if (rms > LIMIAR_FALA && !v.mute) ultimaVoz = Date.now();
      // setOnSpeakingWhileMutedCallback: falando com o microfone desligado → aviso no painel
      const mudoFalando = v.mute && !v.deaf && rms > LIMIAR_FALA;
      if (mudoFalando) v.mudoFalandoAte = Date.now() + 1500;
      const aviso = Date.now() < (v.mudoFalandoAte ?? 0);
      if (aviso !== !!v.avisoMudo) { v.avisoMudo = aviso; avisar(); }
      const agora = Date.now() - ultimaVoz < SEGURA_FALA_MS;
      if (agora === falando) return;
      falando = agora;
      enviar(VOP.SPEAKING, { speaking: falando ? 1 : 0, delay: 0, ssrc: v.ssrc });
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
    v.fonteEscuta = v.ctx.createMediaStreamSource(new MediaStream([v.escuta]));
    v.fonteEscuta.connect(v.analisador);
  }

  // Trocar microfone ou processamento no meio da chamada: abre o novo e troca a faixa em cada conexão,
  // sem renegociar (replaceTrack)
  async function reabrirMicrofone() {
    if (!v) return;
    const conexao = v;
    const { stream: novo, semMic } = await abrirMicrofone();
    if (v !== conexao) { novo.getTracks().forEach((t) => t.stop()); return; } // saiu da voz enquanto abria
    if (semMic) { v.semMic = semMic; avisar(); return; } // continua como estava (ou só ouvindo)
    const [faixa] = novo.getAudioTracks();
    if (v.semMic) { v.semMic = null; v.mute = false; } // achou microfone agora: já sai do mudo
    faixa.enabled = !v.mute;
    const antigas = v.stream.getAudioTracks();
    // o lugar do microfone é o primeiro transceptor de áudio que não é da tela (existe mesmo só ouvindo)
    await Promise.all([...v.pares.values()].map((p) => p.pc.getTransceivers()
      .find((t) => t.receiver.track.kind === 'audio' && !p.telaSenders.includes(t.sender))?.sender.replaceTrack(faixa)));
    antigas.forEach((t) => t.stop());
    v.stream = novo;
    escutarMicrofone();
    enviarGateway({ op: 4, d: estado() });
    avisar();
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
    async definirSaida(id) {
      prefs.saida = String(id ?? ''); salvarPrefs();
      if (v?.saida.ctx.setSinkId) await v.saida.ctx.setSinkId(prefs.saida).catch((e) => alert(`Não foi possível usar essa saída: ${e.message}`));
    },
    async definirEntrada(id) { prefs.entrada = String(id ?? ''); salvarPrefs(); await reabrirMicrofone().catch((e) => alert(`Não foi possível usar esse microfone: ${e.message}`)); },
    async definirProcessamento({ ruido, eco }) {
      if (ruido != null) prefs.ruido = !!ruido;
      if (eco != null) prefs.eco = !!eco;
      salvarPrefs();
      await reabrirMicrofone().catch(() => {});
    },
    escolheSaida: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
  };

  return {
    entrar, sair, alternarMudo, alternarSurdo, servidorPronto, alternarMutoLocal, compartilharTela, pararTela, ajustes,
    mutadoLocal: (userId) => mutadosLocal.has(userId),
    // tela de alguém (ou a minha, como prévia) para o palco; null se não houver
    tela: (userId) => (userId === store.me?.id ? v?.tela?.stream : v?.telas.get(userId)) ?? null,
    surdo: () => !!v?.deaf,
    atual: () => v && { channelId: v.channelId, status: v.status, mute: v.mute, deaf: v.deaf, avisoMudo: !!v.avisoMudo, semMic: v.semMic ?? null,
      transmitindo: !!v.tela, qualidade: v.tela?.qualidade.nome,
      conectados: [...v.pares.values()].filter((p) => p.pc.connectionState === 'connected').length },
    // nova sessão no gateway principal (READY, não RESUMED): a voz antiga não vale mais
    resetar: () => { if (v) { const a = v; v = null; limpar(a); } },
  };
}
