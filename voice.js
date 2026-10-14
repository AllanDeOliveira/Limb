// Voz no desenho do Discord:
//  1. gateway principal, op 4 VOICE_STATE_UPDATE {guild_id, channel_id, self_mute, self_deaf}
//  2. servidor: VOICE_STATE_UPDATE para todos + VOICE_SERVER_UPDATE {token, endpoint} para a sessão
//  3. cliente abre o gateway de voz (endpoint) e faz IDENTIFY (op 0) com o token
// Opcodes (os números do Discord): 0 IDENTIFY, 2 READY, 3 HEARTBEAT, 5 SPEAKING, 6 HEARTBEAT_ACK, 8 HELLO,
// 11 CLIENTS_CONNECT, 12 VIDEO, 13 CLIENT_DISCONNECT. Sem SFU, não há protocolo de mídia a escolher (op 1/4) nem ssrc.
// Compartilhar tela: self_stream no estado de voz (igual ao Discord) + op 12 VIDEO dizendo qual
// stream WebRTC é a tela, para quem recebe separar o áudio da tela do microfone.
// Diferença: o Discord manda a mídia para um SFU dele; aqui é WebRTC direto entre os participantes
// (malha), e o servidor só repassa a sinalização no op 100 PEER_SIGNAL (extensão nossa).
// Como no Discord, a tela só vai para quem está assistindo: o op 101 STREAM_WATCH (extensão nossa) diz
// a quem transmite quem entrou/saiu; a sala recebe o op 12 de novo com viewer_ids (o "N assistindo").
import { randomBytes } from 'node:crypto';
import { VOP } from './public/voz.js'; // uma tabela só para o cliente e o servidor

export { VOP };
const HEARTBEAT = 13750;
const TOKEN_TTL = 30_000;
const MAX_POR_SALA = 8; // ponytail: malha P2P = n² conexões; acima disso precisa de SFU

// iceServers: lista fixa, ou função chamada a cada READY (credenciais de TURN vencem) que devolve a lista
// ou uma Promise dela
export function criarVoz({ broadcast, paraSessao, canalDeVoz, iceServers = [] }) {
  const estados = new Map(); // userId → voice state
  const tokens = new Map(); // token → { user_id, channel_id, session_id, expira }
  const salas = new Map(); // channelId → Map(userId → { ws, video, espectadores: Set(userId) })

  const sala = (cid) => salas.get(cid) ?? salas.set(cid, new Map()).get(cid);
  const enviar = (ws, op, d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ op, d })); };
  const naSala = (cid, op, d, exceto) => { for (const [uid, c] of salas.get(cid) ?? []) if (uid !== exceto) enviar(c.ws, op, d); };
  // op 12 com a lista de quem assiste (vazia = ninguém); quem transmite já sabe pelo op 101
  const avisarEspectadores = (cid, uid, m) => naSala(cid, VOP.VIDEO, { user_id: uid, stream_id: m.video, viewer_ids: [...m.espectadores] }, uid);

  function tirarDaSala(userId, code) {
    for (const [cid, membros] of salas) {
      const c = membros.get(userId);
      if (!c) continue;
      membros.delete(userId);
      if (!membros.size) salas.delete(cid);
      // quem saiu deixa de assistir (a lista de quem transmitia sai junto com ele)
      for (const [uid, m] of membros) {
        if (!m.espectadores.delete(userId)) continue;
        enviar(m.ws, VOP.STREAM_WATCH, { user_id: userId, watching: false });
        avisarEspectadores(cid, uid, m);
      }
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
      const agora = Date.now();
      for (const [k, v] of tokens) if (v.expira < agora) tokens.delete(k); // os nunca usados (aba fechou antes) não ficam para sempre
      tokens.set(token, { user_id: userId, channel_id: channelId, session_id: sessao.id, expira: agora + TOKEN_TTL });
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
    ws.on('error', () => {}); // frame grande demais / UTF-8 inválido: o ws fecha sozinho; sem ouvinte, o servidor caía
    let eu = null, entrando = false, timer;
    const vigiar = () => { clearTimeout(timer); timer = setTimeout(() => ws.close(4009, 'Session timed out'), HEARTBEAT * 1.5); };
    vigiar();
    // o token vale 30 s: quem não se identifica nesse tempo não vai entrar
    const semLogin = setTimeout(() => { if (!eu && !entrando) ws.close(4003, 'Not authenticated'); }, TOKEN_TTL);
    ws.on('close', () => clearTimeout(semLogin));
    enviar(ws, VOP.HELLO, { heartbeat_interval: HEARTBEAT });

    // o token só vale enquanto a pessoa continua naquele canal, por aquela sessão (outra aba não "rouba" a vaga)
    const vale = (t) => estados.get(t.user_id)?.channel_id === t.channel_id && estados.get(t.user_id)?.session_id === t.session_id;
    // Entra na sala de uma vez só (sem await no meio): ninguém sinaliza para quem ainda não recebeu o READY
    function entrar(t, ice) {
      tirarDaSala(t.user_id, 4014);
      const membros = sala(t.channel_id);
      const outros = [...membros.keys()];
      eu = { user_id: t.user_id, channel_id: t.channel_id };
      membros.set(eu.user_id, { ws, espectadores: new Set() });
      enviar(ws, VOP.READY, { ice_servers: Array.isArray(ice) ? ice : [] });
      // quem já está transmitindo (e quem já assiste): chega antes da conexão, para a tela ser reconhecida ao chegar
      for (const [uid, m] of membros) {
        if (m.video) enviar(ws, VOP.VIDEO, { user_id: uid, stream_id: m.video, ...(m.espectadores.size && { viewer_ids: [...m.espectadores] }) });
      }
      enviar(ws, VOP.CLIENTS_CONNECT, { user_ids: outros });
      naSala(eu.channel_id, VOP.CLIENTS_CONNECT, { user_ids: [eu.user_id] }, eu.user_id);
    }

    ws.on('message', (raw) => {
      try { receber(raw); } catch (e) { console.error('[voz]', e); ws.close(4000, 'Erro'); } // nunca derruba o servidor
    });
    function receber(raw) {
      let p;
      try { p = JSON.parse(raw); } catch { return ws.close(4002, 'Decode error'); }
      if (!p || typeof p !== 'object' || Array.isArray(p)) return ws.close(4002, 'Decode error'); // "null", "1", "[]"…
      const d = p.d && typeof p.d === 'object' ? p.d : {};
      if (p.op === VOP.HEARTBEAT) { vigiar(); return enviar(ws, VOP.HEARTBEAT_ACK, { t: d.t }); }

      if (!eu) {
        if (entrando) return; // esperando a lista de ICE: o cliente não manda nada antes do READY
        if (p.op !== VOP.IDENTIFY) return ws.close(4003, 'Not authenticated');
        const t = tokens.get(String(d.token));
        tokens.delete(String(d.token)); // uso único
        const ok = t && t.expira > Date.now() && t.user_id === String(d.user_id) && t.session_id === String(d.session_id) && vale(t);
        if (!ok) return ws.close(4004, 'Authentication failed');
        const ice = typeof iceServers === 'function' ? iceServers() : iceServers;
        if (typeof ice?.then !== 'function') return entrar(t, ice);
        // Lista ainda chegando (credenciais do TURN): enquanto isso o socket pode cair ou a pessoa trocar de canal
        entrando = true;
        Promise.resolve(ice).catch(() => []).then((lista) => {
          entrando = false;
          if (ws.readyState !== 1) return;
          if (!vale(t)) return ws.close(4014, 'Disconnected');
          entrar(t, lista);
        });
        return;
      }

      if (p.op === VOP.SPEAKING) {
        return naSala(eu.channel_id, VOP.SPEAKING, { user_id: eu.user_id, speaking: Number(d.speaking) || 0 }, eu.user_id);
      }
      if (p.op === VOP.VIDEO) {
        const membro = salas.get(eu.channel_id)?.get(eu.user_id);
        const id = typeof d.stream_id === 'string' && /^[\w{}-]{1,64}$/.test(d.stream_id) ? d.stream_id : null;
        // stream novo no lugar de outro (trocou a qualidade): quem assiste continua; parou: ninguém assiste mais
        if (membro) { membro.video = id; if (!id) membro.espectadores.clear(); }
        return naSala(eu.channel_id, VOP.VIDEO, { user_id: eu.user_id, stream_id: id }, eu.user_id);
      }
      if (p.op === VOP.STREAM_WATCH) {
        const alvoId = String(d.user_id), quer = d.watching === true;
        const alvo = salas.get(eu.channel_id)?.get(alvoId);
        if (!alvo || alvoId === eu.user_id || (quer && !alvo.video)) return; // só quem está na sala e transmitindo
        if (quer === alvo.espectadores.has(eu.user_id)) return; // repetido: não faz renegociar à toa
        quer ? alvo.espectadores.add(eu.user_id) : alvo.espectadores.delete(eu.user_id);
        enviar(alvo.ws, VOP.STREAM_WATCH, { user_id: eu.user_id, watching: quer }); // id carimbado pelo servidor
        return avisarEspectadores(eu.channel_id, alvoId, alvo);
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
    }

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
