const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Window control API
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Screen capture API
  getScreenSources: async () => {
    return await ipcRenderer.invoke('get-screen-sources');
  },

  getScreenStream: async (sourceId) => {
    return await ipcRenderer.invoke('get-screen-stream', sourceId);
  },

  // Environment variables (secure access)
  getEnv: (key) => {
    return ipcRenderer.sendSync('get-env', key);
  },

  // Platform information
  platform: process.platform,

  // Check if running in Electron
  isElectron: true,

  // Overlay window API
  createOverlay: async () => {
    return await ipcRenderer.invoke('overlay:create');
  },

  closeOverlay: async () => {
    return await ipcRenderer.invoke('overlay:close');
  },

  updateOverlayTranscript: async (transcript) => {
    return await ipcRenderer.invoke('overlay:update-transcript', transcript);
  },

  updateOverlayReply: async (reply) => {
    return await ipcRenderer.invoke('overlay:update-reply', reply);
  },

  overlayControl: async (command) => {
    return await ipcRenderer.invoke('overlay:control', command);
  },

  overlayExists: async () => {
    return await ipcRenderer.invoke('overlay:exists');
  },

  // Listeners for overlay window
  onTranscriptUpdate: (callback) => {
    ipcRenderer.on('transcript-update', callback);
  },

  onReplyUpdate: (callback) => {
    ipcRenderer.on('reply-update', callback);
  },

  onOverlayControl: (callback) => {
    ipcRenderer.on('overlay-control', callback);
  },

  removeTranscriptListener: (callback) => {
    ipcRenderer.removeListener('transcript-update', callback);
  },

  removeReplyListener: (callback) => {
    ipcRenderer.removeListener('reply-update', callback);
  },

  removeOverlayControlListener: (callback) => {
    ipcRenderer.removeListener('overlay-control', callback);
  },

  // Whisper API (runs in main process)
  whisperInitialize: async (modelName) => {
    return await ipcRenderer.invoke('whisper:initialize', modelName);
  },

  whisperTranscribe: async (audioBuffer, options) => {
    return await ipcRenderer.invoke('whisper:transcribe', audioBuffer, options);
  },

  whisperDispose: async () => {
    return await ipcRenderer.invoke('whisper:dispose');
  },

  // Screen Analysis chat
  sendAnalysisQuestion: async (question) => {
    return await ipcRenderer.invoke('analysis:question', question);
  },
});

// Log that preload script has loaded
console.log('Preload script loaded successfully');
