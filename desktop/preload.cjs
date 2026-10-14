// Ponte nativa, como o `contextBridge.exposeInMainWorld("DiscordNative", …)` do Discord.
// Só expõe funções estreitas; a página nunca recebe ipcRenderer nem acesso ao Node.
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  plataforma: process.platform,
  atencao: (mencoes) => ipcRenderer.send('limb:atencao', Number(mencoes) || 0), // pisca a janela / badge
  focar: () => ipcRenderer.send('limb:focar'),
  // compartilhar tela: lista telas/janelas com miniatura; a escolha vale para o próximo getDisplayMedia
  fontesDeTela: () => ipcRenderer.invoke('limb:fontes'),
  escolherFonte: (id, comAudio) => ipcRenderer.invoke('limb:escolherFonte', String(id), !!comAudio),
  abrirConexao: () => ipcRenderer.send('limb:conexao'),
  // trocar de servidor sem sair da janela: lista (com online/offline), troca, e entrar por convite
  servidores: () => ipcRenderer.invoke('limb:servidores'),
  hospedagem: () => ipcRenderer.invoke('limb:hospedagem'), // null = não está hospedando para amigos
  ligarTailscale: () => ipcRenderer.invoke('limb:ligarTailscale'),
  ligarFunnel: () => ipcRenderer.invoke('limb:ligarFunnel'), // hospedando pela internet: publica de novo
  convite: () => ipcRenderer.invoke('limb:convite'), // { link, mensagem } | null = não hospeda pela internet / fora do ar
  trocarServidor: (url) => ipcRenderer.invoke('limb:trocarServidor', url == null ? null : String(url)),
  entrarPorConvite: (texto) => ipcRenderer.invoke('limb:entrarPorConvite', String(texto).slice(0, 2000)),
};
contextBridge.exposeInMainWorld('LimbNative', api);
