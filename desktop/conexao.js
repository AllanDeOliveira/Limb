// Janela "Servidor": passo a passo para hospedar ou entrar no servidor de um amigo pelo Tailscale.
const $ = (id) => document.getElementById(id);
let cfg = null, ips = [], ts = null, modo = null, lido = null, ultimoTeste = '';

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

// ── Modo ─────────────────────────────────────────────────────────────────────
function escolher(m) {
  modo = m;
  for (const b of document.querySelectorAll('.modo')) b.setAttribute('aria-pressed', String(b.dataset.modo === m));
  $('hospedar').hidden = m !== 'hospedar';
  $('entrar').hidden = m !== 'entrar';
  if (m === 'hospedar') {
    $('compartilhar').checked = true;
    if (!$('codigo').value) $('codigo').value = gerarCodigo(); // sem código, qualquer um que alcance o PC cria conta
    atualizarConvite();
  }
  if (m === 'entrar') { $('colar').focus(); lerColado(); }
  atualizarBotao();
}
for (const b of document.querySelectorAll('.modo')) b.addEventListener('click', () => escolher(b.dataset.modo));

function gerarCodigo() {
  const letras = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => letras[n % letras.length]).join('');
}

// ── Hospedar ─────────────────────────────────────────────────────────────────
function endereco() {
  const ip = ts?.estado === 'Running' ? ts.ip : ips[0]?.endereco;
  return ip ? `http://${ip}:${$('porta').value}` : null;
}
function atualizarConvite() {
  if (modo !== 'hospedar') return;
  const end = endereco();
  const codigo = $('codigo').value.trim();
  $('convite').textContent = end
    ? ['Bora conversar no Limb! 🎧', `Endereço: ${end}`, codigo && `Código de convite: ${codigo}`,
      ts?.estado === 'Running' ? 'Antes, aceite o link do Tailscale que eu te mandei.' : null].filter(Boolean).join('\n')
    : 'Ligue o Tailscale (passo 1) para gerar o convite.';
  $('copiar').disabled = !end;
  $('enderecos').textContent = ips.length ? `Endereços na rede local: ${ips.map((i) => `${i.endereco} (${i.nome})`).join(', ')}` : '';
  if (ts?.estado !== 'Running' && end) $('convite').textContent += '\n\n⚠ Sem Tailscale, esse endereço só funciona na mesma rede (mesma casa).';
}
for (const id of ['codigo', 'porta']) $(id).addEventListener('input', atualizarConvite);
$('abrirShare').addEventListener('click', () => window.conexao.abrirCompartilhar());
$('copiar').addEventListener('click', async () => {
  await window.conexao.copiar($('convite').textContent.split('\n\n⚠')[0]);
  $('copiado').textContent = '✔ copiado! Cole no WhatsApp/Discord do seu amigo.';
  setTimeout(() => { $('copiado').textContent = ''; }, 4000);
});

// ── Entrar ───────────────────────────────────────────────────────────────────
// Aceita a mensagem inteira do convite, só a URL, ou só "100.x.x.x:3000"
function lerColado() {
  const t = $('colar').value;
  let url = /https?:\/\/[^\s<>"'()]+/.exec(t)?.[0];
  if (!url) {
    const m = /\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?\b/.exec(t);
    if (m) url = `http://${m[1]}:${m[2] ?? 3000}`;
  }
  try { url = url && new URL(url).origin; } catch { url = null; }
  const codigo = /c[óo]digo[^:\n]*:\s*(\S+)/i.exec(t)?.[1] ?? '';
  lido = url ? { url, codigo } : null;
  $('lidoEndereco').textContent = url ?? '—';
  $('lidoCodigo').textContent = codigo || '—';
  $('testar').disabled = !url;
  atualizarBotao();
  if (url) testar();
  else { $('resultado').textContent = ''; ultimoTeste = ''; }
}
async function testar(forcar = false) {
  if (!lido || (!forcar && lido.url === ultimoTeste)) return;
  ultimoTeste = lido.url;
  $('resultado').className = '';
  $('resultado').textContent = 'Testando a conexão…';
  const r = await window.conexao.testar(lido.url);
  if (lido?.url !== ultimoTeste) return; // colou outra coisa enquanto testava
  $('resultado').className = r.ok ? 'bom' : 'ruim';
  $('resultado').textContent = r.ok ? '✔ Encontrei o servidor do seu amigo! Clique em “Salvar e reiniciar”.' : `✖ ${r.erro}`;
  $('salvar').textContent = r.ok ? 'Salvar e reiniciar' : 'Salvar mesmo assim';
}
let espera;
$('colar').addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(lerColado, 400); });
$('testar').addEventListener('click', () => testar(true));

// ── Salvar ───────────────────────────────────────────────────────────────────
function atualizarBotao() {
  $('salvar').disabled = !modo || (modo === 'entrar' && !lido);
  if (modo !== 'entrar') $('salvar').textContent = 'Salvar e reiniciar';
}
$('cancelar').addEventListener('click', () => window.close());
$('salvar').addEventListener('click', async () => {
  const r = await window.conexao.salvar({
    modo,
    compartilharNaRede: $('compartilhar').checked,
    porta: Number($('porta').value),
    codigoConvite: $('codigo').value.trim(),
    endpoint: lido?.url ?? '',
    conviteRecebido: lido?.codigo ?? '',
  });
  if (r?.erro) { $('erro').hidden = false; $('erro').textContent = r.erro; }
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
      entrar.addEventListener('click', async () => { entrar.disabled = true; entrar.textContent = 'Reiniciando…'; const r = await window.conexao.trocar(h.url); if (r?.erro) { entrar.disabled = false; entrar.textContent = 'Entrar'; $('erro').hidden = false; $('erro').textContent = r.erro; } });
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
  if (d.erro) { $('erro').hidden = false; $('erro').textContent = d.erro; }
  if (d.primeiraVez) {
    $('titulo').textContent = 'Bem-vindo ao Limb! 👋';
    $('subtitulo').textContent = 'Para conversar com amigos, um de vocês hospeda e os outros entram. Você pode mudar isso depois em “servidor”.';
  }
  $('portatil').hidden = !d.portatil;
  $('porta').value = cfg.porta;
  $('codigo').value = cfg.codigoConvite ?? '';
  $('compartilhar').checked = !!cfg.compartilharNaRede;
  $('iniciarComWindows').checked = !!cfg.iniciarComWindows;
  $('campoIniciar').hidden = !d.podeIniciarComWindows;
  $('iniciarComWindows').addEventListener('change', (e) => window.conexao.iniciarComWindows(e.target.checked));
  desenharLista(cfg.historico ?? [], cfg.endpoint ?? null);
  if (cfg.endpoint) $('colar').value = [cfg.endpoint, cfg.conviteRecebido && `Código: ${cfg.conviteRecebido}`].filter(Boolean).join('\n');
  atualizarTs();
  if (cfg.endpoint) escolher('entrar');
  else if (cfg.compartilharNaRede) escolher('hospedar');
});
