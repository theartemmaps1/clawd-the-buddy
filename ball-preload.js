const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ball', {
  drag: (active) => ipcRenderer.send('ball-drag', !!active),
});
