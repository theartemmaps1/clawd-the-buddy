const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('album', {
  // the cards, oldest first, read once when the window opens
  load: () => ipcRenderer.sendSync('album-load'),
});
