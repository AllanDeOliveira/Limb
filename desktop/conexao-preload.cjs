// Ponte da janela "Servidor" (arquivo local, não a página do servidor)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('conexao', {
  ler: () => ipcRenderer.invoke('conexao:ler'),
  salvar: (cfg) => ipcRenderer.invoke('conexao:salvar', cfg),
  testar: (url) => ipcRenderer.invoke('conexao:testar', String(url)),
  lerConvite: (texto) => ipcRenderer.invoke('conexao:lerConvite', String(texto).slice(0, 2000)), // { url, codigo, tailscale } | null
  tailscale: () => ipcRenderer.invoke('conexao:tailscale'),
  tailscaleLigar: () => ipcRenderer.invoke('conexao:tailscaleLigar'),
  abrirCompartilhar: () => ipcRenderer.invoke('conexao:abrirCompartilhar'),
  copiar: (texto) => ipcRenderer.invoke('conexao:copiar', String(texto)),
  trocar: (url) => ipcRenderer.invoke('conexao:trocar', url == null ? null : String(url)), // null = este computador
  esquecer: (url) => ipcRenderer.invoke('conexao:esquecer', String(url)),
  iniciarComWindows: (ligado) => ipcRenderer.invoke('conexao:iniciarComWindows', !!ligado),
  // publicar pela internet (Funnel): estado, ativar, e o painel da Cloudflare para a chave TURN
  funnel: (porta) => ipcRenderer.invoke('conexao:funnel', Number(porta)),
  funnelLigar: (porta) => ipcRenderer.invoke('conexao:funnelLigar', Number(porta)),
  abrirCloudflare: () => ipcRenderer.invoke('conexao:abrirCloudflare'),
  // "Gerar link novo": o código sai do app (main), que salva e avisa o servidor rodando → { codigo }
  novoConvite: () => ipcRenderer.invoke('conexao:novoConvite'),
});
