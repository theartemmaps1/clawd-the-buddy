const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('album', {
  // the cards, oldest first, read once when the window opens
  load: () => ipcRenderer.sendSync('album-load'),
  // his diary pages, the family tree and how long the scarf is
  more: () => ipcRenderer.sendSync('album-more'),
});
