const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bed', {
  drag: (active) => ipcRenderer.send('bed-drag', !!active),
  onState: (cb) => ipcRenderer.on('room-state', (_e, state) => cb(state)),
});
