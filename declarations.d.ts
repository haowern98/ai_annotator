// This file tells TypeScript that modules loaded via CDN URLs are available.
// It prevents "Cannot find module" errors for these specific URLs.

declare module 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
declare module 'https://cdn.jsdelivr.net/npm/dompurify@3.1.5/dist/purify.es.mjs';

// Electron API type declarations
interface ElectronAPI {
  // Window control API
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  isMaximized: () => Promise<boolean>;

  // Screen capture API
  getScreenSources: () => Promise<Array<{id: string; name: string; thumbnail: string; appIcon?: string | null}>>;
  getScreenStream: (sourceId: string) => Promise<any>;
  
  // Focus captured window (Zoom-like behavior)
  focusCapturedWindow: (sourceId: string) => Promise<{success: boolean; isScreen?: boolean; error?: string; hwnd?: string}>;
  
  // Get primary screen source ID for screen analysis
  getPrimaryScreenSourceId: () => Promise<{success: boolean; sourceId?: string; name?: string; error?: string}>;
  
  // Environment
  getEnv: (key: string) => string | undefined;
  platform: string;
  isElectron: boolean;

  // Overlay window API
  createOverlay: () => Promise<{success: boolean; error?: string}>;
  closeOverlay: () => Promise<void>;
  updateOverlayTranscript: (transcript: string) => Promise<void>;
  updateOverlayReply: (reply: string) => Promise<void>;
  overlayControl: (command: string) => Promise<void>;
  overlayExists: () => Promise<{exists: boolean}>;
  showOverlay: () => Promise<void>;
  hideOverlay: () => Promise<void>;

  // Listeners
  onTranscriptUpdate: (callback: (event: any, data: string) => void) => void;
  onReplyUpdate: (callback: (event: any, data: string) => void) => void;
  onOverlayControl: (callback: (event: any, command: string) => void) => void;
  removeTranscriptListener: (callback: any) => void;
  removeReplyListener: (callback: any) => void;
  removeOverlayControlListener: (callback: any) => void;

  // Whisper API
  whisperInitialize: (modelName: string) => Promise<any>;
  whisperTranscribe: (audioBuffer: ArrayBuffer, options: any) => Promise<any>;
  whisperDispose: () => Promise<void>;

  // Network detection API
  getLocalIP: () => Promise<{success: boolean; ip?: string; error?: string}>;
  getPublicIP: () => Promise<{success: boolean; ip?: string; error?: string}>;

  // Qwen control API
  startQwenRemote: () => Promise<{success: boolean; error?: string}>;
  startQwenLocal: () => Promise<{success: boolean; error?: string}>;
  stopQwen: () => Promise<{success: boolean; message?: string; error?: string}>;
  getServerMode: () => Promise<{success: boolean; isServerMode: boolean}>;

  // Screen Analysis
  sendAnalysisQuestion: (question: string) => Promise<any>;

  // Recording API
  initRecording: () => Promise<{success: boolean; path?: string; error?: string}>;
  saveRecording: (videoData: ArrayBuffer | string | null, metadata: any) => Promise<any>;
  saveRecordingExisting: (videoPath: string, metadata: any) => Promise<any>;
  listRecordings: () => Promise<any>;
  deleteRecording: (videoFilename: string) => Promise<any>;
  getRecordingMetadata: (videoFilename: string) => Promise<any>;
  getRecordingVideo: (videoFilename: string) => Promise<{success: boolean; data?: string; mimeType?: string; error?: string}>;
  getRecordingVideoPath: (videoFilename: string) => Promise<{success: boolean; path?: string; mimeType?: string; error?: string}>;
  pickVideoFile: () => Promise<{success: boolean; canceled?: boolean; path?: string; name?: string; size?: number; error?: string}>;
  ingestVideoToRecordings: (sourcePath: string) => Promise<{success: boolean; videoPath?: string; filename?: string; videoFilename?: string; fileSize?: number; error?: string}>;

  // File + video utils (Upload Queue / batch processing)
  getUserDataPath: () => Promise<string>;
  writeBinary: (filePath: string, base64: string) => Promise<boolean>;
  readBinary: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<string>;
  copyFile: (srcPath: string, dstPath: string) => Promise<boolean>;
  renameFile: (srcPath: string, dstPath: string) => Promise<boolean>;
  deleteFile: (filePath: string) => Promise<boolean>;
  extractAudioFromVideo: (videoPath: string) => Promise<{success: boolean; audioPath?: string; size?: number; error?: string}>;
  extractWavSegment: (wavPath: string, startSeconds: number, durationSeconds: number) => Promise<{success: boolean; audioPath?: string; size?: number; error?: string}>;
  convertVideoToWebM: (videoPath: string) => Promise<{success: boolean; outputPath?: string; size?: number; error?: string}>;
  getVideoDurationMs: (videoPath: string) => Promise<{success: boolean; durationMs?: number; error?: string}>;

  // Web viewer (browser UI on port 7558)
  startWebViewer: (portOverride?: number) => Promise<{success: boolean; port?: number; error?: string; running?: boolean}>;
  stopWebViewer: () => Promise<{success: boolean; error?: string}>;
  getWebViewerStatus: () => Promise<{success: boolean; running: boolean; port: number; lastError?: string | null}>;
  getWebViewerTranscodeJobs: () => Promise<{success: boolean; jobs?: any[]; error?: string}>;
  cancelWebViewerTranscode: (lectureId: string) => Promise<{success: boolean; error?: string}>;
  onWebViewerTranscode: (callback: (payload: any) => void) => void;
  removeWebViewerTranscodeListeners: () => void;

  // Remote full-video upload (client/server inbox)
  getInboxStatus: () => Promise<{success: boolean; status?: any; error?: string}>;
  onInboxActivity: (callback: (activity: any) => void) => void;
  onInboxFileReceived: (callback: (payload: any) => void) => void;
  sendVideoToRemoteServer: (serverUrl: string, filePath: string, displayName?: string) => Promise<{success: boolean; error?: string}>;
  getRemoteJobStatus: (serverUrl: string, jobId: string) => Promise<{success: boolean; data?: any; error?: string; detail?: any}>;
  getRemoteJobResult: (serverUrl: string, jobId: string) => Promise<{success: boolean; data?: any; error?: string; detail?: any}>;
  getRemoteJobTranscript: (serverUrl: string, jobId: string) => Promise<{success: boolean; data?: any; error?: string; detail?: any}>;
  onRemoteUploadProgress: (callback: (payload: any) => void) => void;
  onRemoteUploadComplete: (callback: (payload: any) => void) => void;
  onRemoteUploadError: (callback: (payload: any) => void) => void;

  // YouTube downloader (runs python yt_dlp in .venv)
  downloadYouTube: (
    url: string,
    onProgress?: (data: any) => void
  ) => Promise<{success: boolean; file_path?: string; file_name?: string; title?: string; duration_s?: number; size?: number; error?: string}>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
