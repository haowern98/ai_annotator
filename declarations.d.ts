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
  getScreenSources: () => Promise<Array<{id: string; name: string; thumbnail: string; appIcon?: string | null; display_id?: string}>>;
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

  // Screen Analysis IPC methods
  startScreenAnalysis: () => Promise<{ success: boolean; error?: string }>;
  stopScreenAnalysis: () => Promise<{ success: boolean }>;
  generateAnalysisReply: () => Promise<{ success: boolean; error?: string }>;
  updateOverlayAnalysis: (analysis: any) => Promise<any>;
  onAnalysisUpdate: (callback: (...args: any[]) => void) => void;
  onAnalysisControl: (callback: (...args: any[]) => void) => void;
  removeAnalysisListener: () => void;
  
  // Overlay resize
  resizeOverlay: (dimensions: { width?: number; height?: number }) => Promise<{ success: boolean; error?: string }>;

  // Whisper API
  whisperInitialize: (modelName: string) => Promise<{ success: boolean; error?: string }>;
  whisperTranscribe: (audioBuffer: number[] | Uint8Array | ArrayBuffer, options?: any) => Promise<{ success: boolean; text?: string; error?: string; elapsed?: number }>;
  whisperDispose: () => Promise<{ success: boolean }>;

  // Parakeet API
  parakeetInitialize: () => Promise<{success: boolean; error?: string}>;
  parakeetDispose: () => Promise<{success: boolean}>;
  parakeetHealth: () => Promise<{success: boolean; healthy: boolean; isRunning: boolean}>;

  // Screen Analysis
  sendAnalysisQuestion: (question: string) => Promise<any>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
