const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bed', {
  drag: (active) => ipcRenderer.send('bed-drag', !!active),
});
