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

// Navigation types for in-app routing
export type NavigationView = 'home' | 'interview-details' | 'lecture-details';

export interface NavigationState {
  history: NavigationView[];
  currentIndex: number;
}

// Interview context types for profile management
export interface InterviewContext {
  profileName: string;
  name: string;
  role: string;
  company: string;
  resume: string;
  jobDescription: string;
  notes: string;
}

export interface InterviewProfile {
  id: 1 | 2 | 3;
  context: InterviewContext;
  lastModified: string; // ISO date
}

export interface InterviewProfilesState {
  profiles: (InterviewProfile | null)[];
  activeProfileId: 1 | 2 | 3 | null;
}

// Electron API types
declare global {
  interface Window {
    electronAPI?: {
      // Window control API
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
      isMaximized: () => Promise<boolean>;
      
      getScreenSources: () => Promise<any>;
      getScreenStream: (sourceId: string) => Promise<any>;
      focusCapturedWindow: (sourceId: string) => Promise<{success: boolean; isScreen?: boolean; error?: string; hwnd?: string}>;
      getEnv: (key: string) => string;
      platform: string;
      isElectron: boolean;
      createOverlay: () => Promise<any>;
      closeOverlay: () => Promise<any>;
      hideOverlay: () => Promise<any>;
      showOverlay: () => Promise<any>;
      updateOverlayTranscript: (transcript: any) => Promise<any>;
      updateOverlayReply: (reply: any) => Promise<any>;
      overlayControl: (command: string) => Promise<any>;
      overlayExists: () => Promise<{ exists: boolean }>;
      onTranscriptUpdate: (callback: (...args: any[]) => void) => void;
      onReplyUpdate: (callback: (...args: any[]) => void) => void;
      onOverlayControl: (callback: (...args: any[]) => void) => void;
      removeTranscriptListener: (callback: (...args: any[]) => void) => void;
      removeReplyListener: (callback: (...args: any[]) => void) => void;
      removeOverlayControlListener: (callback: (...args: any[]) => void) => void;
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
      // Whisper IPC methods
      whisperInitialize: (modelName: string) => Promise<{ success: boolean; error?: string }>;
      whisperTranscribe: (audioBuffer: number[] | Uint8Array | ArrayBuffer, options?: any) => Promise<{ success: boolean; text?: string; error?: string; elapsed?: number }>;
      whisperDispose: () => Promise<{ success: boolean }>;

      // Recording API (History / lecture saves)
      initRecording: () => Promise<any>;
      saveRecording: (videoData: any, metadata: any) => Promise<any>;
      listRecordings: () => Promise<any>;
      deleteRecording: (videoFilename: string) => Promise<any>;
      getRecordingMetadata: (videoFilename: string) => Promise<any>;
      getRecordingVideo: (videoFilename: string) => Promise<any>;

      // File + video utils (Upload Queue / batch processing)
      getUserDataPath: () => Promise<string>;
      writeBinary: (filePath: string, base64: string) => Promise<boolean>;
      readBinary: (filePath: string) => Promise<string>;
      writeFile: (filePath: string, content: string) => Promise<boolean>;
      readFile: (filePath: string) => Promise<string>;
      deleteFile: (filePath: string) => Promise<boolean>;
      extractAudioFromVideo: (videoPath: string) => Promise<{ success: boolean; audioPath?: string; size?: number; error?: string }>;
      convertVideoToWebM: (videoPath: string) => Promise<{ success: boolean; outputPath?: string; size?: number; error?: string }>;

      // YouTube downloader (Python yt_dlp in .venv)
      downloadYouTube: (
        url: string,
        onProgress?: (data: any) => void
      ) => Promise<{ success: boolean; file_path?: string; file_name?: string; title?: string; duration_s?: number; size?: number; error?: string }>;
    };
  }
}
