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

  // Screen Analysis
  sendAnalysisQuestion: (question: string) => Promise<any>;

  // File + video utils (Upload Queue / batch processing)
  getUserDataPath: () => Promise<string>;
  writeBinary: (filePath: string, base64: string) => Promise<boolean>;
  readBinary: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<boolean>;
  readFile: (filePath: string) => Promise<string>;
  deleteFile: (filePath: string) => Promise<boolean>;
  extractAudioFromVideo: (videoPath: string) => Promise<{success: boolean; audioPath?: string; size?: number; error?: string}>;
  convertVideoToWebM: (videoPath: string) => Promise<{success: boolean; outputPath?: string; size?: number; error?: string}>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
