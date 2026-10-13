// Ponte da janela "Servidor" (arquivo local, não a página do servidor)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('conexao', {
  ler: () => ipcRenderer.invoke('conexao:ler'),
  salvar: (cfg) => ipcRenderer.invoke('conexao:salvar', cfg),
  testar: (url) => ipcRenderer.invoke('conexao:testar', String(url)),
  tailscale: () => ipcRenderer.invoke('conexao:tailscale'),
  tailscaleLigar: () => ipcRenderer.invoke('conexao:tailscaleLigar'),
  abrirCompartilhar: () => ipcRenderer.invoke('conexao:abrirCompartilhar'),
  copiar: (texto) => ipcRenderer.invoke('conexao:copiar', String(texto)),
  trocar: (url) => ipcRenderer.invoke('conexao:trocar', url == null ? null : String(url)), // null = este computador
  esquecer: (url) => ipcRenderer.invoke('conexao:esquecer', String(url)),
  iniciarComWindows: (ligado) => ipcRenderer.invoke('conexao:iniciarComWindows', !!ligado),
});
