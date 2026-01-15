const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splashAPI', {
  onUpdate: (callback) => {
    ipcRenderer.on('splash:update', (_event, payload) => callback(payload));
  },
});

