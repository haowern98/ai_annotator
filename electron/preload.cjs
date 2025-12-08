const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Window control API
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (callback) => {
    ipcRenderer.on('window:maximize-change', (event, isMaximized) => callback(isMaximized));
  },
  removeMaximizeChangeListener: () => {
    ipcRenderer.removeAllListeners('window:maximize-change');
  },

  // Dialog API
  showMessageBox: async (options) => {
    return await ipcRenderer.invoke('dialog:showMessageBox', options);
  },

  // Screen capture API
  getScreenSources: async () => {
    return await ipcRenderer.invoke('get-screen-sources');
  },

  // Focus captured window (Zoom-like behavior)
  focusCapturedWindow: async (sourceId) => {
    return await ipcRenderer.invoke('focus-captured-window', sourceId);
  },

  // Get primary screen source ID for screen analysis
  getPrimaryScreenSourceId: async () => {
    return await ipcRenderer.invoke('get-primary-screen-source');
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

  showOverlay: async () => {
    return await ipcRenderer.invoke('overlay:show');
  },

  hideOverlay: async () => {
    return await ipcRenderer.invoke('overlay:hide');
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

  // Screen Analysis API
  startScreenAnalysis: async () => {
    return await ipcRenderer.invoke('analysis:start');
  },

  stopScreenAnalysis: async () => {
    return await ipcRenderer.invoke('analysis:stop');
  },

  generateAnalysisReply: async () => {
    return await ipcRenderer.invoke('analysis:generate');
  },

  sendAnalysisQuestion: async (question) => {
    return await ipcRenderer.invoke('analysis:question', question);
  },

  updateOverlayAnalysis: async (analysis) => {
    return await ipcRenderer.invoke('overlay:update-analysis', analysis);
  },

  onAnalysisUpdate: (callback) => {
    ipcRenderer.on('analysis-update', callback);
  },

  onAnalysisControl: (callback) => {
    ipcRenderer.on('analysis-control', callback);
  },

  removeAnalysisListener: () => {
    ipcRenderer.removeAllListeners('analysis-update');
  },

  removeAnalysisControlListener: () => {
    ipcRenderer.removeAllListeners('analysis-control');
  },

  // Overlay resize
  resizeOverlay: async (dimensions) => {
    return await ipcRenderer.invoke('overlay:resize', dimensions);
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

  // =====================================================
  // LECTURE OVERLAY API (separate from Interview overlay)
  // =====================================================

  // Lecture overlay window management
  createLectureOverlay: async () => {
    return await ipcRenderer.invoke('lecture-overlay:create');
  },

  closeLectureOverlay: async () => {
    return await ipcRenderer.invoke('lecture-overlay:close');
  },

  showLectureOverlay: async () => {
    return await ipcRenderer.invoke('lecture-overlay:show');
  },

  hideLectureOverlay: async () => {
    return await ipcRenderer.invoke('lecture-overlay:hide');
  },

  lectureOverlayExists: async () => {
    return await ipcRenderer.invoke('lecture-overlay:exists');
  },

  resizeLectureOverlay: async (dimensions) => {
    return await ipcRenderer.invoke('lecture-overlay:resize', dimensions);
  },

  // Lecture control (pause/resume/stop/generate-summary)
  lectureControl: async (command) => {
    return await ipcRenderer.invoke('lecture-overlay:control', command);
  },

  // Update lecture overlay data (from main app to overlay)
  updateLectureTranscript: async (data) => {
    return await ipcRenderer.invoke('lecture-overlay:update-transcript', data);
  },

  updateLectureSummary: async (data) => {
    return await ipcRenderer.invoke('lecture-overlay:update-summary', data);
  },

  updateLectureStatus: async (data) => {
    return await ipcRenderer.invoke('lecture-overlay:update-status', data);
  },

  // Listeners for lecture overlay window (overlay receives from main)
  onLectureTranscriptUpdate: (callback) => {
    ipcRenderer.on('lecture-transcript-update', callback);
  },

  onLectureSummaryUpdate: (callback) => {
    ipcRenderer.on('lecture-summary-update', callback);
  },

  onLectureStatusUpdate: (callback) => {
    ipcRenderer.on('lecture-status-update', callback);
  },

  // Listener for lecture control commands (main app receives from overlay)
  onLectureControl: (callback) => {
    ipcRenderer.on('lecture-control', callback);
  },

  removeLectureTranscriptListener: (callback) => {
    if (callback) {
      ipcRenderer.removeListener('lecture-transcript-update', callback);
    } else {
      ipcRenderer.removeAllListeners('lecture-transcript-update');
    }
  },

  removeLectureSummaryListener: (callback) => {
    if (callback) {
      ipcRenderer.removeListener('lecture-summary-update', callback);
    } else {
      ipcRenderer.removeAllListeners('lecture-summary-update');
    }
  },

  removeLectureStatusListener: (callback) => {
    if (callback) {
      ipcRenderer.removeListener('lecture-status-update', callback);
    } else {
      ipcRenderer.removeAllListeners('lecture-status-update');
    }
  },

  removeLectureControlListener: (callback) => {
    if (callback) {
      ipcRenderer.removeListener('lecture-control', callback);
    } else {
      ipcRenderer.removeAllListeners('lecture-control');
    }
  },

  // =====================================================
  // RECORDING API
  // =====================================================

  // Initialize recordings directory and get path
  initRecording: async () => {
    return await ipcRenderer.invoke('recording:init');
  },

  // Save video recording with metadata
  saveRecording: async (videoData, metadata) => {
    return await ipcRenderer.invoke('recording:save', videoData, metadata);
  },

  // List all saved recordings
  listRecordings: async () => {
    return await ipcRenderer.invoke('recording:list');
  },

  // Delete a recording (both video and metadata)
  deleteRecording: async (videoFilename) => {
    return await ipcRenderer.invoke('recording:delete', videoFilename);
  },

  // Get recording metadata
  getRecordingMetadata: async (videoFilename) => {
    return await ipcRenderer.invoke('recording:metadata', videoFilename);
  },

  // Get video file data as base64
  getRecordingVideo: async (videoFilename) => {
    return await ipcRenderer.invoke('recording:getVideo', videoFilename);
  },
});

// Log that preload script has loaded
console.log('Preload script loaded successfully');
