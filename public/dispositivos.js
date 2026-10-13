// Regras de microfone e saída de áudio sem DOM nem WebRTC (dá para testar no Node).
// Como o Discord: o microfone não depende de um aparelho só — se o escolhido some, usa outro
// (o do notebook) e volta para ele quando reaparece; no "Padrão do sistema", segue o padrão do Windows.

// 'default' e 'communications' são apelidos que o Chromium cria no Windows, não aparelhos de verdade
export const APELIDOS = ['default', 'communications'];
// Erros em que vale tentar outro microfone; NotAllowedError (bloqueado) vale para todos
export const TENTA_OUTRO = new Set(['NotFoundError', 'OverconstrainedError', 'NotReadableError', 'AbortError']);

// "Padrão - Microfone (Realtek Audio)" → "Microfone (Realtek Audio)"
export const nomeDispositivo = (label) => String(label ?? '').replace(/^(padrão|default|comunicações|communications)\s+-\s+/i, '');

// Quem é o microfone padrão do sistema agora. null sem permissão (sem nomes não dá para comparar).
// Firefox não tem a entrada 'default': o primeiro da lista é o padrão.
export function assinaturaPadrao(lista) {
  const entradas = lista.filter((d) => d.kind === 'audioinput');
  const d = entradas.find((x) => x.deviceId === 'default') ?? entradas[0];
  return d?.label ? `${d.groupId}|${d.label}` : null;
}

// Microfones para tentar depois do escolhido e do padrão, na ordem do sistema
export const outrasEntradas = (lista, jaTentados = []) => lista
  .filter((d) => d.kind === 'audioinput' && d.deviceId && !APELIDOS.includes(d.deviceId) && !jaTentados.includes(d.deviceId))
  .map((d) => d.deviceId);

// O que fazer depois de um devicechange numa chamada: true = reabrir o microfone
export function deveReabrir({ lista, semMic, bloqueado, faixaViva, idAtual, escolhido, padraoAntes, padraoAgora }) {
  const entradas = lista.filter((d) => d.kind === 'audioinput');
  if (semMic) return entradas.length > 0 && !bloqueado; // só ouvindo e apareceu microfone (bloqueado: não adianta)
  if (!faixaViva) return true; // desconectado
  if (escolhido) return idAtual !== escolhido && entradas.some((d) => d.deviceId === escolhido); // o escolhido voltou
  return !!padraoAntes && !!padraoAgora && padraoAntes !== padraoAgora; // o padrão do sistema mudou
}

// Saída: a escolhida se estiver conectada; senão o padrão do sistema ('')
export const alvoSaida = (lista, escolhida) => (escolhida && lista.some((d) => d.kind === 'audiooutput' && d.deviceId === escolhida) ? escolhida : '');

// Opções do <select> da página "Voz e áudio". O escolhido que sumiu continua na lista (desconectado),
// para a escolha não se perder: quando ele volta, a chamada volta para ele sozinha.
export function opcoesDispositivos(lista, tipo, escolhido = '', nomeSalvo = '') {
  const doTipo = lista.filter((d) => d.kind === tipo);
  const padrao = nomeDispositivo(doTipo.find((d) => d.deviceId === 'default')?.label);
  const reais = doTipo.filter((d) => d.deviceId && !APELIDOS.includes(d.deviceId));
  const generico = tipo === 'audioinput' ? 'Microfone' : 'Saída';
  const opcoes = [{ value: '', nome: padrao ? `Padrão do sistema — ${padrao}` : 'Padrão do sistema', selected: !escolhido },
    ...reais.map((d, i) => ({ value: d.deviceId, nome: d.label || `${generico} ${i + 1}`, selected: d.deviceId === escolhido }))];
  if (escolhido && !reais.some((d) => d.deviceId === escolhido)) {
    const nome = nomeSalvo || `${generico} escolhido`;
    // sem permissão a lista vem sem ids: não dá para saber se está conectado
    opcoes.push({ value: escolhido, nome: reais.length ? `${nome} (desconectado)` : nome, selected: true });
  }
  return opcoes;
}

// Volume (RMS) → 0–100 em escala de decibéis (-60 dB a 0 dB), como a barra do Discord
export const nivelDe = (rms) => (rms > 0 ? Math.min(100, Math.max(0, (20 * Math.log10(rms) + 60) / 60 * 100)) : 0);
