// Voz no desenho do Discord:
//  1. gateway principal, op 4 VOICE_STATE_UPDATE {guild_id, channel_id, self_mute, self_deaf}
//  2. servidor: VOICE_STATE_UPDATE para todos + VOICE_SERVER_UPDATE {token, endpoint} para a sessão
//  3. cliente abre o gateway de voz (endpoint) e faz IDENTIFY (op 0) com o token
// Opcodes do gateway de voz observados no bundle: 0 IDENTIFY, 1 SELECT_PROTOCOL, 2 READY, 3 HEARTBEAT,
// 4 SESSION_DESCRIPTION, 5 SPEAKING, 6 HEARTBEAT_ACK, 8 HELLO, 11 CLIENTS_CONNECT, 12 VIDEO, 13 CLIENT_DISCONNECT.
// Compartilhar tela: self_stream no estado de voz (igual ao Discord) + op 12 VIDEO dizendo qual
// stream WebRTC é a tela, para quem recebe separar o áudio da tela do microfone.
// Diferença: o Discord manda a mídia para um SFU dele; aqui é WebRTC direto entre os participantes
// (malha), e o servidor só repassa a sinalização no op 100 PEER_SIGNAL (extensão nossa).
import { randomBytes, randomInt } from 'node:crypto';

export const VOP = {
  IDENTIFY: 0, SELECT_PROTOCOL: 1, READY: 2, HEARTBEAT: 3, SESSION_DESCRIPTION: 4, SPEAKING: 5,
  HEARTBEAT_ACK: 6, HELLO: 8, CLIENTS_CONNECT: 11, VIDEO: 12, CLIENT_DISCONNECT: 13, PEER_SIGNAL: 100,
};
const HEARTBEAT = 13750;
const TOKEN_TTL = 30_000;
const MAX_POR_SALA = 8; // ponytail: malha P2P = n² conexões; acima disso precisa de SFU

export function criarVoz({ broadcast, paraSessao, canalDeVoz, iceServers = [] }) {
  const estados = new Map(); // userId → voice state
  const tokens = new Map(); // token → { user_id, guild_id, channel_id, session_id, expira }
  const salas = new Map(); // channelId → Map(userId → { ws, ssrc, video })

  const sala = (cid) => salas.get(cid) ?? salas.set(cid, new Map()).get(cid);
  const enviar = (ws, op, d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ op, d })); };
  const naSala = (cid, op, d, exceto) => { for (const [uid, c] of salas.get(cid) ?? []) if (uid !== exceto) enviar(c.ws, op, d); };

  function tirarDaSala(userId, code) {
    for (const [cid, membros] of salas) {
      const c = membros.get(userId);
      if (!c) continue;
      membros.delete(userId);
      if (!membros.size) salas.delete(cid);
      naSala(cid, VOP.CLIENT_DISCONNECT, { user_id: userId });
      if (code) c.ws.close(code, 'Disconnected');
    }
  }

  // op 4 no gateway principal. Retorna mensagem de erro ou null.
  function atualizarEstado(sessao, d) {
    const userId = String(sessao.user.id);
    const channelId = d?.channel_id == null ? null : String(d.channel_id);
    const anterior = estados.get(userId);
    if (channelId == null) {
      if (!anterior) return null;
      estados.delete(userId);
      tirarDaSala(userId, 4014); // 4014 = desconectado do canal
      broadcast('VOICE_STATE_UPDATE', { ...anterior, channel_id: null });
      return null;
    }
    const canal = canalDeVoz(channelId);
    if (!canal) return 'Canal de voz não encontrado';
    if (anterior?.channel_id !== channelId && (salas.get(channelId)?.size ?? 0) >= MAX_POR_SALA) return 'Canal de voz cheio';
    const estado = {
      user_id: userId, guild_id: String(canal.guild_id), channel_id: channelId, session_id: sessao.id,
      self_mute: !!d.self_mute, self_deaf: !!d.self_deaf, self_stream: !!d.self_stream,
    };
    estados.set(userId, estado);
    broadcast('VOICE_STATE_UPDATE', estado);
    // Trocou de canal (ou de aba): token novo e o gateway de voz antigo sai da sala
    if (anterior?.channel_id !== channelId || anterior?.session_id !== sessao.id) {
      tirarDaSala(userId, 4014);
      const token = randomBytes(16).toString('hex');
      tokens.set(token, { user_id: userId, guild_id: estado.guild_id, channel_id: channelId, session_id: sessao.id, expira: Date.now() + TOKEN_TTL });
      paraSessao(sessao, 'VOICE_SERVER_UPDATE', { token, guild_id: estado.guild_id, channel_id: channelId, endpoint: '/voice' });
    }
    return null;
  }

  // Sessão principal acabou: sai da voz se era ela que estava conectada
  function sair(sessao) {
    const e = estados.get(String(sessao.user.id));
    if (e?.session_id === sessao.id) atualizarEstado(sessao, { channel_id: null });
  }

  function gatewayVoz(ws) {
    let eu = null, timer;
    const vigiar = () => { clearTimeout(timer); timer = setTimeout(() => ws.close(4009, 'Session timed out'), HEARTBEAT * 1.5); };
    vigiar();
    enviar(ws, VOP.HELLO, { heartbeat_interval: HEARTBEAT, v: 8 });

    ws.on('message', (raw) => {
      let p;
      try { p = JSON.parse(raw); } catch { return ws.close(4002, 'Decode error'); }
      const d = p.d ?? {};
      if (p.op === VOP.HEARTBEAT) { vigiar(); return enviar(ws, VOP.HEARTBEAT_ACK, { t: d.t }); }

      if (!eu) {
        if (p.op !== VOP.IDENTIFY) return ws.close(4003, 'Not authenticated');
        const t = tokens.get(String(d.token));
        tokens.delete(String(d.token)); // uso único
        const ok = t && t.expira > Date.now() && t.user_id === String(d.user_id) && t.session_id === String(d.session_id)
          && t.guild_id === String(d.server_id) && estados.get(t.user_id)?.channel_id === t.channel_id;
        if (!ok) return ws.close(4004, 'Authentication failed');
        tirarDaSala(t.user_id, 4014);
        const membros = sala(t.channel_id);
        const outros = [...membros.keys()];
        eu = { user_id: t.user_id, channel_id: t.channel_id, ssrc: randomInt(1, 2 ** 31) };
        membros.set(eu.user_id, { ws, ssrc: eu.ssrc });
        enviar(ws, VOP.READY, { ssrc: eu.ssrc, ip: '', port: 0, modes: ['webrtc-p2p'], heartbeat_interval: HEARTBEAT, ice_servers: iceServers });
        // quem já está transmitindo: chega antes da conexão, para a tela ser reconhecida ao chegar
        for (const [uid, m] of membros) if (m.video) enviar(ws, VOP.VIDEO, { user_id: uid, stream_id: m.video });
        enviar(ws, VOP.CLIENTS_CONNECT, { user_ids: outros });
        naSala(eu.channel_id, VOP.CLIENTS_CONNECT, { user_ids: [eu.user_id] }, eu.user_id);
        return;
      }

      if (p.op === VOP.SELECT_PROTOCOL) {
        return enviar(ws, VOP.SESSION_DESCRIPTION, { mode: 'webrtc-p2p', audio_codec: 'opus', video_codec: null });
      }
      if (p.op === VOP.SPEAKING) {
        return naSala(eu.channel_id, VOP.SPEAKING, { user_id: eu.user_id, ssrc: eu.ssrc, speaking: Number(d.speaking) || 0 }, eu.user_id);
      }
      if (p.op === VOP.VIDEO) {
        const membro = salas.get(eu.channel_id)?.get(eu.user_id);
        const id = typeof d.stream_id === 'string' && /^[\w{}-]{1,64}$/.test(d.stream_id) ? d.stream_id : null;
        if (membro) membro.video = id;
        return naSala(eu.channel_id, VOP.VIDEO, { user_id: eu.user_id, stream_id: id }, eu.user_id);
      }
      if (p.op === VOP.PEER_SIGNAL) {
        const alvo = salas.get(eu.channel_id)?.get(String(d.to));
        if (!alvo) return;
        // só repassa os campos de sinalização, com tamanho limitado (o socket já tem maxPayload)
        const sinal = { from: eu.user_id };
        if (d.description && typeof d.description.sdp === 'string') sinal.description = { type: String(d.description.type), sdp: d.description.sdp };
        if (d.candidate && typeof d.candidate === 'object') sinal.candidate = d.candidate;
        return enviar(alvo.ws, VOP.PEER_SIGNAL, sinal);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!eu) return;
      const membros = salas.get(eu.channel_id);
      if (membros?.get(eu.user_id)?.ws !== ws) return; // já substituído por outra conexão
      tirarDaSala(eu.user_id);
    });
  }

  return { estados, atualizarEstado, sair, gatewayVoz };
}
