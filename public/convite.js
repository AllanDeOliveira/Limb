// Página de convite (/convite/<código>; o convite que não vale nem carrega este script). Sem JS ela já
// funciona (entrar pelo navegador e baixar); aqui ela só fica mais esperta: o botão principal depende do aparelho, o "abrir no app" ganha o endereço
// que a pessoa abriu de verdade e, antes de baixar, o convite vai para a área de transferência:
// o Limb recém-instalado o encontra lá sozinho (como o Discord faz com discord.gg/… ao abrir o app).
const $ = (s) => document.querySelector(s);
const codigo = document.querySelector('main').dataset.codigo ?? '';
const acoes = $('#acoes'), navegador = $('#navegador'), baixar = $('#baixar'), abrirApp = $('#abrirApp'), aviso = $('#aviso');

const ua = navigator.userAgent;
const dados = navigator.userAgentData; // Chrome/Edge; Firefox e Safari só têm o userAgent
// o Safari do iPad se passa por Mac ("Macintosh", sem "Mobile"): a tela de toque entrega
const celular = dados ? dados.mobile : /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const windows = !celular && (dados?.platform ? dados.platform === 'Windows' : /Windows NT/.test(ua));

// limb://entrar?servidor=…&convite=… (o app desktop registra o protocolo)
abrirApp.href = `limb://entrar?servidor=${encodeURIComponent(location.origin)}${codigo ? `&convite=${encodeURIComponent(codigo)}` : ''}`;
abrirApp.hidden = !windows; // o Limb só existe para Windows: no resto (celular, iPad, Mac, Linux) ninguém abre limb://

// No PC com Windows o caminho principal é baixar; no resto, entrar pelo navegador (já é o padrão do HTML)
if (windows) {
  navegador.classList.remove('principal');
  baixar.classList.add('principal');
  acoes.prepend(baixar);
  baixar.after(abrirApp);
}
$('#smartscreen').hidden = !windows;

baixar.addEventListener('click', async (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // nova aba/janela: o navegador decide
  e.preventDefault();
  let copiou = false;
  try {
    // writeText pode ficar pendurado esperando permissão: não segura o download por isso
    await Promise.race([navigator.clipboard.writeText(location.href), new Promise((_, falhar) => setTimeout(falhar, 1500))]);
    copiou = true;
  } catch { /* sem permissão ou sem HTTPS: segue sem copiar */ }
  aviso.textContent = copiou
    ? 'Convite copiado: quando o Limb abrir, ele encontra o convite sozinho.'
    : 'Quando o Limb abrir, cole o link desta página na janela "Servidor" para entrar.';
  location.href = baixar.href;
});

