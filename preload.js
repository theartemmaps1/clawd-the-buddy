const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('buddy', {
  onEvent: on('claude-event'),
  onCursor: on('buddy-cursor'),
  onWalkDone: on('buddy-walk-done'),
  onSettings: on('buddy-settings'),
  onConfigLoaded: on('buddy-config-loaded'),
  onAskMood: on('buddy-ask-mood'),
  onAskDay: on('buddy-ask-day'),
  onFly: on('buddy-fly'),
  onBounce: on('buddy-bounce'),
  onLanded: on('buddy-landed'),
  onFocusResult: on('buddy-focus-result'),
  onWear: on('buddy-wear'),
  onBall: on('buddy-ball'),
  onBatted: on('buddy-batted'),
  onContext: on('buddy-context'),

  ignoreMouse: (ignore) => ipcRenderer.send('buddy-ignore-mouse', !!ignore),
  drag: (active) => ipcRenderer.send('buddy-drag', !!active),
  menu: () => ipcRenderer.send('buddy-menu'),
  walk: (offset) => ipcRenderer.send('buddy-walk', { x: offset.x, y: offset.y }),
  chase: (active) => ipcRenderer.send('buddy-chase', !!active),
  focus: (sessionId) => ipcRenderer.send('buddy-focus', String(sessionId || '')),
  wardrobe: (state) => ipcRenderer.send('buddy-wardrobe', state),
});
