const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prints', {
  onCursor: (fn) => ipcRenderer.on('prints-cursor', (_e, p) => fn(p)),
  wiped: (left) => ipcRenderer.send('prints-wiped', left),
});
