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

// Electron API types are defined in declarations.d.ts