export enum AppStatus {
  IDLE = 'IDLE',
  CAPTURING = 'CAPTURING',
  CONNECTING = 'CONNECTING',
  ANALYZING = 'ANALYZING',
  STOPPING = 'STOPPING',
  ERROR = 'ERROR',
}

export interface Summary {
  id: string;
  text: string;
  timestamp: string;
}

export enum LogLevel {
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
}

// Electron API types
declare global {
  interface Window {
    electronAPI?: {
      getScreenSources: () => Promise<any>;
      getScreenStream: (sourceId: string) => Promise<any>;
      getEnv: (key: string) => string;
      platform: string;
      isElectron: boolean;
      createOverlay: () => Promise<any>;
      closeOverlay: () => Promise<any>;
      updateOverlayTranscript: (transcript: any) => Promise<any>;
      updateOverlayReply: (reply: any) => Promise<any>;
      overlayControl: (command: string) => Promise<any>;
      overlayExists: () => Promise<boolean>;
      onTranscriptUpdate: (callback: (...args: any[]) => void) => void;
      onReplyUpdate: (callback: (...args: any[]) => void) => void;
      onOverlayControl: (callback: (...args: any[]) => void) => void;
      removeTranscriptListener: (callback: (...args: any[]) => void) => void;
      removeReplyListener: (callback: (...args: any[]) => void) => void;
      removeOverlayControlListener: (callback: (...args: any[]) => void) => void;
      // Whisper IPC methods
      whisperInitialize: (modelName: string) => Promise<{ success: boolean; error?: string }>;
      whisperTranscribe: (audioBuffer: number[] | Uint8Array | ArrayBuffer, options?: any) => Promise<{ success: boolean; text?: string; error?: string; elapsed?: number }>;
      whisperDispose: () => Promise<{ success: boolean }>;
    };
  }
}