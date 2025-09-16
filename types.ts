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