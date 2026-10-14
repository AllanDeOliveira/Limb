// Janela "Servidor": passo a passo para hospedar (pela internet ou pelo Tailscale) ou entrar no servidor de um amigo.
const $ = (id) => document.getElementById(id);
let cfg = null, ips = [], ts = null, modo = null, lido = null, ultimoTeste = '';
let como = 'internet'; // hospedando: 'internet' (Funnel, os amigos só abrem um link) ou 'tailscale' (cada amigo instala)
let funnel = null, acaoFunnel = null; // estado do Funnel; acaoFunnel: 'ativando' | 'autorizar' | { erro }
let doClipboard = false; // o convite veio do que a pessoa tinha copiado (primeira vez)
let trocandoToken = false, removerTurn = false;
let codigoConvite = ''; // o código vai escondido no link; quem gera é o app (main), nunca esta janela
let mensagem = ''; // o convite pronto para colar no WhatsApp (o "Copiar convite" copia isto)

const mostrarErro = (t) => { $('erro').hidden = !t; $('erro').textContent = t ?? ''; if (t) $('erro').scrollIntoView({ block: 'nearest' }); };
// Só reescreve o que mudou: as consultas de 3 s não repetem o status no leitor de tela nem desfazem uma seleção
const escrever = (el, t) => { if (el.textContent !== t) el.textContent = t; };

// ── Tailscale ────────────────────────────────────────────────────────────────
const ESTADOS = {
  semInstalar: ['ruim', 'O Tailscale não está instalado.', 'Baixar o Tailscale'],
  NeedsLogin: ['aviso', 'Instalado. Falta entrar na sua conta.', 'Entrar no Tailscale'],
  Stopped: ['aviso', 'O Tailscale está desligado.', 'Ligar'],
  Indisponivel: ['aviso', 'O Tailscale não está rodando.', 'Abrir o Tailscale'],
};
async function atualizarTs() {
  const antes = ts?.estado;
  ts = await window.conexao.tailscale();
  const chave = !ts.instalado ? 'semInstalar' : ts.estado;
  const [cls, texto, botao] = ts.estado === 'Running'
    ? ['ok', `Conectado${ts.conta ? ` (${ts.conta})` : ''}. Este computador: ${ts.nome} · ${ts.ip}`, null]
    : ESTADOS[chave] ?? ['aviso', `Tailscale: ${ts.estado}…`, null];
  $('ts').className = `ts ${cls}`;
  $('tsTexto').textContent = texto;
  $('tsBotao').hidden = !botao;
  $('tsBotao').textContent = botao ?? '';
  if (ts.nome) $('meuNome').textContent = ts.nome;
  atualizarConvite();
  desenharFunnel();
  // acabou de conectar: refaz o teste que tinha falhado por causa do Tailscale
  if (antes && antes !== 'Running' && ts.estado === 'Running' && modo === 'entrar') testar(true);
}
$('tsBotao').addEventListener('click', async () => {
  $('tsBotao').disabled = true;
  const r = await window.conexao.tailscaleLigar();
  $('tsBotao').disabled = false;
  if (r?.baixando) $('tsTexto').textContent = 'Instale o Tailscale que está baixando no navegador e entre com sua conta. Esta janela atualiza sozinha.';
  else if (r?.login) $('tsTexto').textContent = 'Termine o login no navegador. Esta janela atualiza sozinha.';
  else if (r?.erro) $('tsTexto').textContent = r.erro;
  setTimeout(atualizarTs, 1500);
});
setInterval(atualizarTs, 3000);

// O status do Tailscale fica no passo 1 do "Hospedar". No "Entrar", só aparece para convite 100.x:
// pelo link da internet o amigo não precisa de Tailscale nenhum.
function lugarDoTs() {
  const precisa = modo === 'entrar' && !!lido?.tailscale;
  $('entrarTs').hidden = $('entrarAceite').hidden = !precisa;
  const lugar = precisa ? $('tsLugarEntrar') : $('tsLugarHospedar');
  if ($('ts').parentElement !== lugar) lugar.append($('ts'));
}

// ── Modo ─────────────────────────────────────────────────────────────────────
function escolher(m) {
  modo = m;
  for (const b of document.querySelectorAll('.modo')) b.setAttribute('aria-pressed', String(b.dataset.modo === m));
  $('hospedar').hidden = m !== 'hospedar';
  $('entrar').hidden = m !== 'entrar';
  if (m === 'hospedar') {
    // sem código, qualquer um que alcance o PC cria conta. Só com a configuração lida: antes dela, "sem código"
    // pode ser só "ainda não sei", e gerar um derrubaria o link que os amigos já têm
    if (cfg && !codigoConvite) gerarLink();
    escolherComo(como);
  }
  if (m === 'entrar') { $('colar').focus(); lerColado(); }
  lugarDoTs();
  atualizarBotao();
}
for (const b of document.querySelectorAll('.modo')) b.addEventListener('click', () => escolher(b.dataset.modo));

// Como os amigos entram. Pelo Tailscale eles chegam pela rede: o servidor precisa aceitar conexões de fora.
// Pela internet o Funnel entrega tudo localmente, e fechado para a rede é mais seguro.
function escolherComo(c, porClique = false) {
  como = c;
  for (const r of document.querySelectorAll('input[name=como]')) r.checked = r.value === c;
  for (const li of document.querySelectorAll('[data-como]')) li.hidden = li.dataset.como !== c;
  if (c === 'tailscale') $('compartilhar').checked = true;
  else if (porClique) $('compartilhar').checked = false;
  $('tsDica').textContent = c === 'internet'
    ? 'Só você precisa dele: seus amigos não instalam nada. Grátis.'
    : 'O Tailscale liga você e seus amigos com segurança, sem mexer no roteador. Grátis.';
  // Código curto escolhido à mão antes da 1.8: pela internet ele é a tranca, então troca já, antes de o link
  // aparecer (e de alguém copiar um link que o "Salvar" invalidaria)
  if (c === 'internet' && modo === 'hospedar' && cfg && codigoConvite && codigoConvite.length < 6) { codigoConvite = ''; gerarLink(); }
  atualizarFirewall();
  atualizarConvite();
  desenharFunnel();
  atualizarFunnel();
}
for (const r of document.querySelectorAll('input[name=como]')) r.addEventListener('change', () => escolherComo(r.value, true));
// Só aceitando conexões da rede o Windows pergunta sobre o firewall
function atualizarFirewall() { $('dicaFirewall').hidden = !$('compartilhar').checked; }
$('compartilhar').addEventListener('change', atualizarFirewall);

// ── Hospedar ─────────────────────────────────────────────────────────────────
function endereco() {
  const ip = ts?.estado === 'Running' ? ts.ip : ips[0]?.endereco;
  return ip ? `http://${ip}:${$('porta').value}` : null;
}
// O convite é só o link (o código vai dentro dele): pela internet, o https://….ts.net/convite/…; pelo Tailscale,
// o http://100.x:porta/convite/…, que o amigo cola na janela Servidor dele (ou abre no navegador)
function atualizarConvite() {
  if (modo !== 'hospedar') return;
  $('enderecos').textContent = ips.length ? `Endereços na rede local: ${ips.map((i) => `${i.endereco} (${i.nome})`).join(', ')}` : '';
  let link = null, aviso = '';
  if (como === 'internet') {
    const origem = funnel?.publicado ? funnel.url : ts?.dns ? `https://${ts.dns}` : null;
    if (origem && codigoConvite) link = `${origem}/convite/${encodeURIComponent(codigoConvite)}`;
    // mesmo texto de mensagemConvite em desktop/convite.js
    mensagem = link ? `Bora conversar no Limb! 🎧\nEntra por aqui: ${link}\n(Abre no navegador ou baixa o app. Não precisa de Tailscale.)` : '';
    if (!origem) aviso = 'Ligue o Tailscale (passo 1) para gerar o link.';
    else if (!funnel?.publicado) aviso = '⚠ O link só funciona depois de publicar na internet (passo 2).';
  } else {
    const end = endereco();
    if (end && codigoConvite) link = `${end}/convite/${encodeURIComponent(codigoConvite)}`;
    mensagem = link ? ['Bora conversar no Limb! 🎧', `Abre no app: ${link}`,
      ts?.estado === 'Running' && '(Antes, aceite o link do Tailscale que eu te mandei.)'].filter(Boolean).join('\n') : '';
    if (!end) aviso = 'Ligue o Tailscale (passo 1) para gerar o link.';
    else if (ts?.estado !== 'Running') aviso = '⚠ Sem Tailscale, esse endereço só funciona na mesma rede (mesma casa).';
  }
  if (!codigoConvite) aviso = 'Gerando o link…';
  if ($('linkConvite').value !== (link ?? '')) $('linkConvite').value = link ?? '';
  escrever($('conviteAviso'), aviso);
  $('copiar').disabled = !link;
}
$('porta').addEventListener('input', () => { atualizarConvite(); atualizarFunnel(); });
$('abrirShare').addEventListener('click', () => window.conexao.abrirCompartilhar());
$('linkConvite').addEventListener('focus', () => $('linkConvite').select());
$('copiar').addEventListener('click', async () => {
  await window.conexao.copiar(mensagem);
  $('copiado').textContent = '✔ copiado! Cole no WhatsApp/Discord do seu amigo.';
  setTimeout(() => { $('copiado').textContent = ''; }, 4000);
});
// Link novo: o código é gerado no app (main), salvo e passado na hora para o servidor que está rodando.
// Os links antigos param de criar conta; quem já tem conta continua entrando normalmente.
let gerando = null; // um pedido por vez: escolher "Hospedar" duas vezes não gera dois links
function gerarLink() {
  gerando ??= (async () => {
    $('novoLink').disabled = true;
    const r = await window.conexao.novoConvite().catch(() => null);
    $('novoLink').disabled = false;
    if (!r?.codigo) return mostrarErro('Não foi possível gerar o link. Tente de novo.');
    codigoConvite = r.codigo;
    atualizarConvite();
  })().finally(() => { gerando = null; });
  return gerando;
}
$('novoLink').addEventListener('click', async () => {
  if (!confirm('Os links antigos param de funcionar. Gerar um link novo?')) return;
  await gerarLink();
  if (!codigoConvite) return;
  $('copiado').textContent = '✔ Link novo pronto. Mande para quem você quer convidar.';
  setTimeout(() => { $('copiado').textContent = ''; }, 4000);
});

// ── Publicar na internet (Funnel) ────────────────────────────────────────────
const internetVisivel = () => modo === 'hospedar' && como === 'internet';
async function atualizarFunnel() {
  if (!internetVisivel()) return;
  const porta = $('porta').value;
  const f = await window.conexao.funnel(porta);
  if (porta !== $('porta').value) return; // mudou a porta durante a consulta: a próxima vale
  funnel = f;
  if (f?.publicado && acaoFunnel !== 'ativando') acaoFunnel = null;
  desenharFunnel();
  atualizarConvite();
}
function desenharFunnel() {
  if (!internetVisivel()) return;
  let cls = 'aviso', t, botao = null;
  if (ts && ts.estado !== 'Running') t = 'Primeiro ligue o Tailscale (passo 1).';
  else if (acaoFunnel === 'ativando') { t = 'Ativando…'; botao = 'Ativando…'; }
  else if (funnel?.publicado) { cls = 'ok'; t = `No ar: ${funnel.url}`; }
  else if (acaoFunnel === 'autorizar') { t = 'Autorize no navegador: abrimos a página do Tailscale. Clique em Enable e volte aqui.'; botao = 'Abrir a página de novo'; }
  else if (acaoFunnel?.erro) { cls = 'ruim'; t = acaoFunnel.erro; botao = 'Tentar de novo'; }
  else if (!funnel) t = 'Verificando…';
  else if (funnel.ativo) {
    t = funnel.porta ? `Publicado, mas na porta ${funnel.porta}, e o Limb vai usar a ${$('porta').value}. Clique em Ativar para corrigir.`
      : 'Publicado, mas apontando para outro programa. Clique em Ativar para apontar para o Limb.';
    botao = 'Ativar';
  }
  else { t = 'Ainda não está na internet.'; botao = 'Ativar'; }
  $('funnel').className = `ts ${cls}`;
  escrever($('funnelTexto'), t);
  $('funnelBotao').hidden = !botao;
  escrever($('funnelBotao'), botao ?? '');
  $('funnelBotao').disabled = acaoFunnel === 'ativando';
}
$('funnelBotao').addEventListener('click', async () => {
  acaoFunnel = 'ativando';
  desenharFunnel();
  const r = await window.conexao.funnelLigar($('porta').value);
  acaoFunnel = r?.autorizar ? 'autorizar' : r?.erro ? { erro: r.erro } : null;
  desenharFunnel();
  atualizarFunnel();
});
setInterval(atualizarFunnel, 3000);

// ── Voz pelo 4G: TURN da Cloudflare ──────────────────────────────────────────
// Depois de salvo, o token não volta para a tela: só "Token salvo (termina em …abcd)", com trocar e remover
function desenharTurn() {
  const salvo = !!cfg.turnCloudflare?.tokenSalvo && !trocandoToken && !removerTurn;
  $('turnSalvo').hidden = !salvo;
  $('turnCampoToken').hidden = salvo;
  $('turnFim').textContent = cfg.turnCloudflare?.fimDoToken ? `(termina em …${cfg.turnCloudflare.fimDoToken})` : '';
}
$('abrirCloudflare').addEventListener('click', () => window.conexao.abrirCloudflare());
$('turnTrocar').addEventListener('click', () => { trocandoToken = true; desenharTurn(); $('turnToken').focus(); });
$('turnRemover').addEventListener('click', () => {
  removerTurn = true;
  $('turnId').value = '';
  $('turnToken').value = '';
  desenharTurn();
  $('turnStatus').textContent = 'A chave sai quando você salvar.';
  $('turnId').focus();
});
// digitou uma chave nova depois de "Remover": vale a nova
for (const id of ['turnId', 'turnToken']) $(id).addEventListener('input', () => {
  if (!removerTurn || !$(id).value) return;
  removerTurn = false;
  trocandoToken = true;
  $('turnStatus').textContent = '';
});

// ── Entrar ───────────────────────────────────────────────────────────────────
// Lido no processo principal (desktop/convite.js): esta janela não importa módulos
async function lerColado() {
  const texto = $('colar').value;
  const r = await window.conexao.lerConvite(texto);
  if ($('colar').value !== texto) return; // mudou enquanto lia: a leitura nova vem a seguir
  lido = r;
  $('lidoEndereco').textContent = lido?.url ?? '—';
  $('lidoConvite').textContent = lido?.codigo ? ' · com convite' : '';
  $('testar').disabled = !lido;
  lugarDoTs();
  atualizarBotao();
  if (lido) testar();
  else { $('resultado').textContent = ''; ultimoTeste = ''; }
}
async function testar(forcar = false) {
  if (!lido || (!forcar && lido.url === ultimoTeste)) return;
  ultimoTeste = lido.url;
  $('resultado').className = '';
  $('resultado').textContent = 'Testando a conexão…';
  $('salvar').textContent = 'Salvar e entrar';
  const r = await window.conexao.testar(lido.url);
  if (lido?.url !== ultimoTeste) return; // colou outra coisa enquanto testava
  const nome = r.nome || new URL(lido.url).host;
  $('resultado').className = r.ok ? 'bom' : 'ruim';
  $('resultado').textContent = !r.ok ? `✖ ${r.erro}`
    : doClipboard ? `✔ Encontramos o convite que você copiou: ${nome} — clique em “Salvar e entrar”.`
    : `✔ Encontrei o servidor ${nome}! Clique em “Salvar e entrar”.`;
  $('salvar').textContent = r.ok ? 'Salvar e entrar' : 'Salvar mesmo assim';
}
let espera;
$('colar').addEventListener('input', () => { doClipboard = false; clearTimeout(espera); espera = setTimeout(lerColado, 400); });
$('testar').addEventListener('click', () => testar(true));

// ── Salvar ───────────────────────────────────────────────────────────────────
function atualizarBotao() {
  $('salvar').disabled = !modo || (modo === 'entrar' && !lido);
  if (modo !== 'entrar') $('salvar').textContent = 'Salvar e reiniciar';
  else if ($('salvar').textContent === 'Salvar e reiniciar') $('salvar').textContent = 'Salvar e entrar';
}
$('cancelar').addEventListener('click', () => window.close());
$('salvar').addEventListener('click', async () => {
  $('salvar').disabled = true; // salvar pode levar uns segundos (tira o Funnel do ar, testa o servidor)
  const r = await window.conexao.salvar({
    modo,
    compartilharNaRede: $('compartilhar').checked,
    porta: Number($('porta').value),
    endpoint: lido?.url ?? '',
    conviteRecebido: lido?.codigo ?? '',
    internet: como === 'internet',
    nomeServidor: $('nomeServidor').value.trim(),
    turnKeyId: $('turnId').value.trim(),
    turnToken: $('turnToken').value.trim(),
    turnRemover: removerTurn,
  });
  if (r?.erro) { mostrarErro(r.erro); atualizarBotao(); }
});

// ── Seus servidores (histórico) ──────────────────────────────────────────────
// "Este computador" sempre aparece; os outros, do mais recente para o mais antigo, com status testado na hora
function desenharLista(historico, atual) {
  const quando = (t) => (t ? new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '');
  const itens = [{ url: null, nome: 'Este computador', detalhe: 'Hospedar aqui' }, ...historico.map((h) => ({ ...h, detalhe: `${h.url} · usado em ${quando(h.ultimoUso)}` }))];
  const lista = $('lista');
  lista.replaceChildren(...itens.map((h) => {
    const eAtual = h.url === atual;
    const li = document.createElement('li');
    li.className = `srv${eAtual ? ' atual' : ''}`;
    const bola = Object.assign(document.createElement('span'), { className: 'bola', title: 'Verificando…' });
    const info = document.createElement('span');
    info.className = 'info';
    info.append(Object.assign(document.createElement('b'), { textContent: h.nome }), Object.assign(document.createElement('small'), { className: 'mut', textContent: h.detalhe }));
    li.append(bola, info);
    if (eAtual) li.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'ATUAL' }));
    else {
      const entrar = Object.assign(document.createElement('button'), { type: 'button', className: 'ok', textContent: 'Entrar' });
      entrar.addEventListener('click', async () => { entrar.disabled = true; entrar.textContent = 'Reiniciando…'; const r = await window.conexao.trocar(h.url); if (r?.erro) { entrar.disabled = false; entrar.textContent = 'Entrar'; mostrarErro(r.erro); } });
      li.append(entrar);
    }
    if (h.url && !eAtual) {
      const x = Object.assign(document.createElement('button'), { type: 'button', className: 'x', textContent: '✕', title: 'Esquecer este servidor', ariaLabel: `Esquecer ${h.nome}` });
      x.addEventListener('click', async () => desenharLista(await window.conexao.esquecer(h.url), atual));
      li.append(x);
    }
    // este computador só tem servidor rodando quando é o atual; os outros respondem (ou não) a /api/info
    if (!h.url) { bola.className = `bola${eAtual ? ' on' : ''}`; bola.title = eAtual ? 'No ar' : 'Sobe quando você escolher hospedar aqui'; }
    else window.conexao.testar(h.url).then((r) => { bola.className = `bola ${r.ok ? 'on' : 'off'}`; bola.title = r.ok ? 'No ar' : r.erro; });
    return li;
  }));
}

// ── Início ───────────────────────────────────────────────────────────────────
window.conexao.ler().then((d) => {
  ({ config: cfg, ips } = d);
  if (d.erro) mostrarErro(d.erro);
  if (d.primeiraVez) {
    $('titulo').textContent = 'Bem-vindo ao Limb! 👋';
    $('subtitulo').textContent = 'Para conversar com amigos, um de vocês hospeda e os outros entram. Você pode mudar isso depois em “servidor”.';
  }
  $('portatil').hidden = !d.portatil;
  $('porta').value = cfg.porta;
  codigoConvite = cfg.codigoConvite ?? '';
  $('nomeServidor').value = cfg.nomeServidor ?? '';
  $('nomeServidor').placeholder = d.nomePadrao ?? '';
  $('turnId').value = cfg.turnCloudflare?.keyId ?? '';
  desenharTurn();
  $('compartilhar').checked = !!cfg.compartilharNaRede;
  $('iniciarComWindows').checked = !!cfg.iniciarComWindows;
  $('campoIniciar').hidden = !d.podeIniciarComWindows;
  $('iniciarComWindows').addEventListener('change', (e) => window.conexao.iniciarComWindows(e.target.checked));
  // quem já hospedava pelo Tailscale continua nele; o resto começa pela internet (recomendado)
  como = cfg.internet || !cfg.compartilharNaRede ? 'internet' : 'tailscale';
  desenharLista(cfg.historico ?? [], cfg.endpoint ?? null);
  // o convite volta como link (o código vai dentro dele, como no que o amigo mandou)
  const comoLink = (url, c) => (c ? `${url}/convite/${encodeURIComponent(c)}` : url);
  if (cfg.endpoint) $('colar').value = comoLink(cfg.endpoint, cfg.conviteRecebido);
  else if (d.colado) {
    // primeira vez com um convite copiado: já vem preenchido e testado
    $('colar').value = comoLink(d.colado.url, d.colado.codigo);
    doClipboard = true;
  }
  atualizarTs();
  if (cfg.endpoint || d.colado) escolher('entrar');
  else if (cfg.compartilharNaRede || cfg.internet) escolher('hospedar');
  if (modo === 'hospedar' && !codigoConvite) gerarLink(); // clicou em "Hospedar" antes de a configuração chegar
});
