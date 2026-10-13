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
};
contextBridge.exposeInMainWorld('LimbNative', api);
contextBridge.exposeInMainWorld('REANative', api); // servidores de antes do nome Limb (até 1.2) procuram este nome
