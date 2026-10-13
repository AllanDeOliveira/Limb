// Atualização pelo GitHub Releases.
// Instalado: o electron-updater baixa a versão nova em segundo plano e pergunta se pode reiniciar.
// Portátil (não tem como se atualizar sozinho): só avisa que há versão nova e abre a página de download.
import { app, dialog, net, shell } from 'electron';
import updater from 'electron-updater';

const REPO = 'AllanDeOliveira/Limb';
const PAGINA = `https://github.com/${REPO}/releases/latest`;
const INTERVALO = 6 * 60 * 60_000; // procura de novo a cada 6 h (o app costuma ficar aberto)

const maior = (a, b) => {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, '').split(/[.-]/).map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

export function iniciarAtualizacao(janela) {
  if (!app.isPackaged || process.env.LIMB_SEM_ATUALIZACAO) return; // em desenvolvimento não procura
  const portatil = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const procurar = portatil ? () => avisarPortatil(janela) : () => updater.autoUpdater.checkForUpdates().catch(() => {});

  if (!portatil) {
    const { autoUpdater } = updater;
    autoUpdater.autoInstallOnAppQuit = true; // se recusar o reinício, instala quando o app fechar
    autoUpdater.on('error', (e) => console.error('[atualização]', e?.message ?? e)); // sem internet etc.: tenta no próximo intervalo
    autoUpdater.on('update-downloaded', async ({ version }) => {
      const { response } = await dialog.showMessageBox(janela(), {
        type: 'info', buttons: ['Reiniciar agora', 'Depois'], defaultId: 0, cancelId: 1,
        title: 'Limb', message: `A versão ${version} do Limb está pronta.`,
        detail: 'Reinicie para usar. Se escolher "Depois", ela é instalada quando você fechar o app.',
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
  }
  setTimeout(procurar, 10_000); // depois da abertura, para não competir com o carregamento
  setInterval(procurar, INTERVALO);
}

let avisada = null;
async function avisarPortatil(janela) {
  try {
    const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const { tag_name: versao } = await r.json();
    if (!versao || versao === avisada || !maior(versao, app.getVersion())) return;
    avisada = versao;
    const { response } = await dialog.showMessageBox(janela(), {
      type: 'info', buttons: ['Baixar', 'Agora não'], defaultId: 0, cancelId: 1,
      title: 'Limb', message: `Saiu a versão ${versao.replace(/^v/, '')} do Limb.`,
      detail: 'A versão portátil não se atualiza sozinha. Dica: o instalador se atualiza automaticamente.',
    });
    if (response === 0) shell.openExternal(PAGINA);
  } catch {} // sem internet: tenta de novo no próximo intervalo
}
