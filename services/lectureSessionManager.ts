import LectureDualSessionManager, { 
  TranscriptEntry, 
  SummaryEntry, 
  LectureDualSessionCallbacks 
} from './lectureDualSessionManager';
import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

// Re-export types for backwards compatibility
export type { TranscriptEntry, SummaryEntry };

interface LectureSessionCallbacks {
  onTranscriptUpdate: (transcripts: TranscriptEntry[], current: string | null) => void;
  onSummaryUpdate: (summaries: SummaryEntry[], isGenerating: boolean) => void;
  onPartialSummary?: (text: string) => void;
  onError: (error: string) => void;
  onConnectionChange: (connected: boolean) => void;
}

/**
 * LectureSessionManager - Orchestrates dual-session lecture capture
 * 
 * Uses LectureDualSessionManager internally:
 * - Session 1 (Transcript): Receives audio, outputs real-time transcription
 * - Session 2 (Summary): Receives video frames + transcript text, generates time-window summaries
 */
class LectureSessionManager {
  private dualManager: LectureDualSessionManager | null = null;
  private log: LogFunction;
  private callbacks: LectureSessionCallbacks | null = null;

  // Media capture
  private mediaStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;
  private audioContext: AudioContext | null = null;
  private audioWorklet: AudioWorkletNode | null = null;

  // State
  private isRunning = false;
  private isPaused = false;
  private sessionStartTime: number = 0;

  constructor(log: LogFunction) {
    this.log = log;
  }

  public async start(
    mediaStream: MediaStream,
    videoElement: HTMLVideoElement,
    canvasElement: HTMLCanvasElement,
    callbacks: LectureSessionCallbacks
  ): Promise<void> {
    if (this.isRunning) {
      this.log('[LectureSession] Already running', LogLevel.WARN);
      return;
    }

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      callbacks.onError('API_KEY not configured');
      return;
    }

    this.mediaStream = mediaStream;
    this.videoElement = videoElement;
    this.canvasElement = canvasElement;
    this.callbacks = callbacks;
    this.sessionStartTime = Date.now();

    // Create the dual session manager
    this.dualManager = new LectureDualSessionManager(this.log);

    try {
      // Start dual sessions (transcript + summary)
      await this.dualManager.start(
        apiKey,
        {
          onTranscriptUpdate: (transcripts, current) => {
            callbacks.onTranscriptUpdate(transcripts, current);
          },
          onSummaryUpdate: (summaries, isGenerating) => {
            // Convert SummaryEntry to simpler format for backward compatibility
            const simpleSummaries = summaries.map(s => ({
              id: s.id,
              text: s.text,
              timestamp: s.timestampMs,
              windowLabel: s.windowLabel,
            }));
            callbacks.onSummaryUpdate(simpleSummaries as any, isGenerating);
          },
          onPartialSummary: (text) => {
            callbacks.onPartialSummary?.(text);
          },
          onError: (error) => {
            this.log(`[LectureSession] Error: ${error}`, LogLevel.ERROR);
            callbacks.onError(error);
          },
          onConnectionChange: (transcriptConnected, summaryConnected) => {
            // Report connected if both are connected
            const connected = transcriptConnected && summaryConnected;
            callbacks.onConnectionChange(connected);
          },
        },
        mediaStream,
        videoElement,
        canvasElement
      );

      this.isRunning = true;

      // Start audio capture (sends to transcript service via dual manager)
      await this.startAudioCapture();

      this.log('[LectureSession] Dual-session started successfully', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[LectureSession] Failed to start: ${message}`, LogLevel.ERROR);
      callbacks.onError(message);
      this.cleanup();
    }
  }

  private async startAudioCapture(): Promise<void> {
    if (!this.mediaStream) return;

    const audioTracks = this.mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      this.log('[LectureSession] No audio track found', LogLevel.WARN);
      return;
    }

    try {
      this.audioContext = new AudioContext({ sampleRate: 16000 });

      // Load audio worklet
      await this.audioContext.audioWorklet.addModule('/audio-processor.js');

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.audioWorklet = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');

      this.audioWorklet.port.onmessage = (event) => {
        if (this.isPaused || !this.dualManager?.isTranscriptConnected()) return;

        // The audio processor sends { pcmData: Int16Array }
        const pcmData = event.data.pcmData as Int16Array;
        const base64Audio = this.arrayBufferToBase64(pcmData.buffer as ArrayBuffer);

        // Audio is now sent directly by LectureDualSessionManager
        // This wrapper file is deprecated - audio capture happens in dualManager
        this.log('[LectureSession] Audio captured (handled by dualManager)', LogLevel.INFO);
      };

      source.connect(this.audioWorklet);
      // Don't connect to destination to avoid echo

      this.log('[LectureSession] Audio capture started', LogLevel.SUCCESS);
    } catch (error) {
      this.log(`[LectureSession] Audio capture error: ${error}`, LogLevel.ERROR);
    }
  }

  public generateSummary(): void {
    if (!this.dualManager?.isSummaryConnected()) {
      this.log('[LectureSession] Cannot generate summary - not connected', LogLevel.WARN);
      return;
    }

    this.dualManager.generateSummary();
  }

  public pause(): void {
    this.isPaused = true;
    this.dualManager?.pause();
    this.log('[LectureSession] Paused', LogLevel.INFO);
  }

  public resume(): void {
    this.isPaused = false;
    this.dualManager?.resume();
    this.log('[LectureSession] Resumed', LogLevel.INFO);
  }

  public async stop(): Promise<void> {
    await this.cleanup();
    this.log('[LectureSession] Stopped', LogLevel.INFO);
  }

  private async cleanup(): Promise<void> {
    // Stop audio
    if (this.audioWorklet) {
      this.audioWorklet.disconnect();
      this.audioWorklet = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Stop dual manager (handles video intervals and service disconnection)
    if (this.dualManager) {
      await this.dualManager.stop();
      this.dualManager = null;
    }

    this.isRunning = false;
    this.isPaused = false;
    this.callbacks?.onConnectionChange(false);
  }

  // Helper: ArrayBuffer to Base64
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Getters
  public getTranscripts(): TranscriptEntry[] {
    return this.dualManager?.getTranscripts() ?? [];
  }

  public getSummaries(): SummaryEntry[] {
    return this.dualManager?.getSummaries() ?? [];
  }

  public getElapsedTime(): number {
    return this.dualManager?.getElapsedTime() ?? 0;
  }

  public formatTimestamp(ms: number): string {
    if (!this.dualManager) {
      const totalSeconds = Math.floor(ms / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
    }
    return `[${this.dualManager.formatTimestamp(ms)}]`;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getIsPaused(): boolean {
    return this.isPaused;
  }

  public getIsConnected(): boolean {
    return (this.dualManager?.isTranscriptConnected() && this.dualManager?.isSummaryConnected()) ?? false;
  }

  public getCurrentWindowIndex(): number {
    return this.dualManager?.getCurrentWindowIndex() ?? 0;
  }
}

export default LectureSessionManager;
export type { LectureSessionCallbacks };
