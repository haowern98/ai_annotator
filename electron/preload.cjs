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

  // Network detection API
  getLocalIP: async () => {
    return await ipcRenderer.invoke('network:get-local-ip');
  },

  getPublicIP: async () => {
    return await ipcRenderer.invoke('network:get-public-ip');
  },

  // Qwen control API
  startQwenRemote: async () => {
    return await ipcRenderer.invoke('qwen:start-remote');
  },

  startQwenLocal: async () => {
    return await ipcRenderer.invoke('qwen:start-local');
  },

  stopQwen: async () => {
    return await ipcRenderer.invoke('qwen:stop');
  },

  getServerMode: async () => {
    return await ipcRenderer.invoke('qwen:get-server-mode');
  },

  // =====================================================
  // REMOTE FULL-VIDEO UPLOAD (client/server inbox)
  // =====================================================

  getInboxStatus: async () => {
    return await ipcRenderer.invoke('inbox:status');
  },
  updateInboxJob: async (jobId, partial) => {
    return await ipcRenderer.invoke('inbox:update-job', jobId, partial);
  },
  completeInboxJob: async (jobId, metadataPath) => {
    return await ipcRenderer.invoke('inbox:complete-job', jobId, metadataPath);
  },
  errorInboxJob: async (jobId, error) => {
    return await ipcRenderer.invoke('inbox:error-job', jobId, error);
  },
  onInboxActivity: (callback) => {
    ipcRenderer.on('inbox:activity', (event, activity) => callback(activity));
  },
  onInboxFileReceived: (callback) => {
    ipcRenderer.on('inbox:file-received', (event, payload) => callback(payload));
  },
  removeInboxListeners: () => {
    ipcRenderer.removeAllListeners('inbox:activity');
    ipcRenderer.removeAllListeners('inbox:file-received');
  },

  sendVideoToRemoteServer: async (serverUrl, filePath, displayName) => {
    return await ipcRenderer.invoke('remoteUpload:sendFile', serverUrl, filePath, displayName);
  },
  getRemoteJobStatus: async (serverUrl, jobId) => {
    return await ipcRenderer.invoke('remoteUpload:getStatus', serverUrl, jobId);
  },
  getRemoteJobResult: async (serverUrl, jobId) => {
    return await ipcRenderer.invoke('remoteUpload:getResult', serverUrl, jobId);
  },
  getRemoteJobTranscript: async (serverUrl, jobId) => {
    return await ipcRenderer.invoke('remoteUpload:getTranscript', serverUrl, jobId);
  },
  remoteLibraryList: async (serverUrl) => {
    return await ipcRenderer.invoke('remoteUpload:libraryList', serverUrl);
  },
  remoteLibraryMeta: async (serverUrl, lectureId) => {
    return await ipcRenderer.invoke('remoteUpload:libraryMeta', serverUrl, lectureId);
  },
  remoteLibraryWords: async (serverUrl, lectureId) => {
    return await ipcRenderer.invoke('remoteUpload:libraryWords', serverUrl, lectureId);
  },
  remoteYouTubeIngest: async (serverUrl, url, jobId) => {
    return await ipcRenderer.invoke('remoteUpload:youtubeIngest', serverUrl, url, jobId);
  },
  onRemoteUploadProgress: (callback) => {
    ipcRenderer.on('remoteUpload:progress', (event, payload) => callback(payload));
  },
  onRemoteUploadComplete: (callback) => {
    ipcRenderer.on('remoteUpload:complete', (event, payload) => callback(payload));
  },
  onRemoteUploadError: (callback) => {
    ipcRenderer.on('remoteUpload:error', (event, payload) => callback(payload));
  },
  removeRemoteUploadListeners: () => {
    ipcRenderer.removeAllListeners('remoteUpload:progress');
    ipcRenderer.removeAllListeners('remoteUpload:complete');
    ipcRenderer.removeAllListeners('remoteUpload:error');
  },

  // Qwen server activity (remote server mode)
  getQwenActivity: async () => {
    return await ipcRenderer.invoke('qwen:get-activity');
  },
  onQwenActivity: (callback) => {
    ipcRenderer.on('qwen:activity', (event, activity) => callback(activity));
  },
  removeQwenActivityListener: () => {
    ipcRenderer.removeAllListeners('qwen:activity');
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

  // Lecture overlay ready handshake
  notifyLectureOverlayReady: async () => {
    return await ipcRenderer.invoke('lecture-overlay:ready');
  },

  onLectureOverlayReady: (callback) => {
    ipcRenderer.on('lecture-overlay-ready', callback);
  },

  removeLectureOverlayReadyListener: (callback) => {
    if (callback) {
      ipcRenderer.removeListener('lecture-overlay-ready', callback);
    } else {
      ipcRenderer.removeAllListeners('lecture-overlay-ready');
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

  // Pick a local video file (main-process dialog; returns a filesystem path)
  pickVideoFile: async () => {
    return await ipcRenderer.invoke('recording:pickVideoFile');
  },

  // Copy a local video file into recordings immediately (ingest step)
  ingestVideoToRecordings: async (sourcePath) => {
    return await ipcRenderer.invoke('recording:ingestVideo', sourcePath);
  },

  // Copy a local video file into recordings with a forced base filename (no extension).
  ingestVideoToRecordingsAs: async (sourcePath, baseFilename) => {
    return await ipcRenderer.invoke('recording:ingestVideoAs', sourcePath, baseFilename);
  },

  // Write a deterministic chunk file into recordings (remote overlay).
  writeRecordingChunk: async (videoData, baseFilename, chunkIndex, ext) => {
    return await ipcRenderer.invoke('recording:writeChunk', videoData, baseFilename, chunkIndex, ext);
  },

  // Write a manifest file into recordings (remote overlay).
  writeRecordingManifest: async (baseFilename, manifest) => {
    return await ipcRenderer.invoke('recording:writeManifest', baseFilename, manifest);
  },

  // Save metadata for an already-present video file (no in-memory video transfer)
  saveRecordingExisting: async (videoPath, metadata) => {
    return await ipcRenderer.invoke('recording:saveExisting', videoPath, metadata);
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

  // Set lecture title override (display only; does not rename files)
  setRecordingTitle: async (lectureId, title) => {
    return await ipcRenderer.invoke('recording:setTitle', lectureId, title);
  },

  // Get video file data as base64
  getRecordingVideo: async (videoFilename) => {
    return await ipcRenderer.invoke('recording:getVideo', videoFilename);
  },

  // Get video file path for streaming playback (avoid base64 for large files)
  getRecordingVideoPath: async (videoFilename) => {
    return await ipcRenderer.invoke('recording:getVideoPath', videoFilename);
  },

  // =====================================================
  // FILE + VIDEO UTILS (Upload Queue)
  // =====================================================

  getUserDataPath: async () => {
    return await ipcRenderer.invoke('fs:getUserDataPath');
  },

  writeBinary: async (filePath, base64) => {
    return await ipcRenderer.invoke('fs:writeBinary', filePath, base64);
  },

  readBinary: async (filePath) => {
    return await ipcRenderer.invoke('fs:readBinary', filePath);
  },

  writeFile: async (filePath, content) => {
    return await ipcRenderer.invoke('fs:writeFile', filePath, content);
  },

  readFile: async (filePath) => {
    return await ipcRenderer.invoke('fs:readFile', filePath);
  },

  copyFile: async (srcPath, dstPath) => {
    return await ipcRenderer.invoke('fs:copyFile', srcPath, dstPath);
  },

  renameFile: async (srcPath, dstPath) => {
    return await ipcRenderer.invoke('fs:renameFile', srcPath, dstPath);
  },

  deleteFile: async (filePath) => {
    return await ipcRenderer.invoke('fs:deleteFile', filePath);
  },

  extractAudioFromVideo: async (videoPath) => {
    return await ipcRenderer.invoke('video:extractAudioFromVideo', videoPath);
  },

  extractWavSegment: async (wavPath, startSeconds, durationSeconds) => {
    return await ipcRenderer.invoke('audio:extractWavSegment', wavPath, startSeconds, durationSeconds);
  },

  convertVideoToWebM: async (videoPath) => {
    return await ipcRenderer.invoke('video:convertVideoToWebM', videoPath);
  },

  concatWebm: async (inputPaths, outputPath) => {
    return await ipcRenderer.invoke('video:concatWebm', inputPaths, outputPath);
  },

  remuxVideoInPlace: async (videoPath) => {
    return await ipcRenderer.invoke('video:remuxInPlace', videoPath);
  },
  getVideoDurationMs: async (videoPath) => {
    return await ipcRenderer.invoke('video:getDurationMs', videoPath);
  },

  // Web viewer (browser UI on port 7558)
  startWebViewer: async (portOverride) => {
    return await ipcRenderer.invoke('webviewer:start', portOverride);
  },

  stopWebViewer: async () => {
    return await ipcRenderer.invoke('webviewer:stop');
  },

  getWebViewerStatus: async () => {
    return await ipcRenderer.invoke('webviewer:status');
  },
  getWebViewerTranscodeJobs: async () => {
    return await ipcRenderer.invoke('webviewer:transcodeList');
  },
  cancelWebViewerTranscode: async (lectureId) => {
    return await ipcRenderer.invoke('webviewer:transcodeCancel', lectureId);
  },
  onWebViewerTranscode: (callback) => {
    ipcRenderer.on('webviewer:transcode', (_event, payload) => callback(payload));
  },
  removeWebViewerTranscodeListeners: () => {
    ipcRenderer.removeAllListeners('webviewer:transcode');
  },

  // Lecture embedding index (main-process indexing for local RAG)
  indexLectureEmbeddings: async (metadataPath, opts) => {
    return await ipcRenderer.invoke('embedding:indexLecture', metadataPath, opts);
  },
  onEmbeddingIndexProgress: (callback) => {
    ipcRenderer.on('embedding:indexProgress', (_event, payload) => callback(payload));
  },
  removeEmbeddingIndexProgressListeners: () => {
    ipcRenderer.removeAllListeners('embedding:indexProgress');
  },
  embedLectureQuery: async (query) => {
    return await ipcRenderer.invoke('embedding:embedQuery', query);
  },

  // YouTube downloader (Python yt_dlp in .venv)
  downloadYouTube: async (url, onProgress, options) => {
    const id = `yt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const channel = 'youtube:download-progress';
    const handler = (_event, data) => {
      if (!data || data.id !== id) return;
      try {
        onProgress?.(data);
      } catch {
        // ignore
      }
    };
    ipcRenderer.on(channel, handler);
    try {
      return await ipcRenderer.invoke('youtube:download', { url, id, ...(options || {}) });
    } finally {
      ipcRenderer.removeListener(channel, handler);
    }
  },
});

// Log that preload script has loaded
console.log('Preload script loaded successfully');
