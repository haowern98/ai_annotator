import { LogLevel } from '../types';
import ParakeetStreamingClient from './parakeetStreamingClient';

type LogFunction = (message: string, level?: LogLevel) => void;

export interface TranscriptEntry {
  id: string;
  text: string;
  timestampMs: number; // Elapsed ms since session start
  isFinal: boolean;
}

export interface SummaryEntry {
  id: string;
  text: string;
  timestampMs: number;
  windowStart: number;
  windowEnd: number;
  windowLabel: string;
}

export interface LectureParakeetSessionCallbacks {
  onTranscriptUpdate: (transcripts: TranscriptEntry[], currentText: string | null) => void;
  onSummaryUpdate: (summaries: SummaryEntry[], isGenerating: boolean) => void;
  onPartialSummary?: (text: string) => void;
  onError: (error: string) => void;
  onConnectionChange: (transcriptConnected: boolean, summaryConnected: boolean) => void;
}

export default class LectureParakeetSessionManager {
  private log: LogFunction;
  private callbacks: LectureParakeetSessionCallbacks | null = null;

  private client: ParakeetStreamingClient | null = null;
  private mediaStream: MediaStream | null = null;

  private audioContext: AudioContext | null = null;
  private audioWorklet: AudioWorkletNode | null = null;

  private isRunning = false;
  private isPaused = false;
  private sessionStartTime = 0;

  private transcripts: TranscriptEntry[] = [];
  private lastFullText = '';
  private pendingText: string | null = null;
  private pendingTimestampMs = 0;
  private nextId = 0;
  private startedStreaming = false;

  constructor(log: LogFunction) {
    this.log = log;
  }

  public getElapsedTime(): number {
    if (this.sessionStartTime === 0) return 0;
    return Date.now() - this.sessionStartTime;
  }

  public formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
  }

  public getTranscripts(): TranscriptEntry[] {
    return this.transcripts;
  }

  public getSummaries(): SummaryEntry[] {
    return [];
  }

  public async start(
    callbacks: LectureParakeetSessionCallbacks,
    mediaStream: MediaStream,
    _videoElement: HTMLVideoElement,
    _canvasElement: HTMLCanvasElement
  ): Promise<void> {
    if (this.isRunning) {
      this.log('[LectureParakeet] Already running', LogLevel.WARN);
      return;
    }

    this.callbacks = callbacks;
    this.mediaStream = mediaStream;
    this.sessionStartTime = Date.now();
    this.isRunning = true;
    this.isPaused = false;

    this.transcripts = [];
    this.lastFullText = '';
    this.pendingText = null;
    this.pendingTimestampMs = 0;
    this.nextId = 0;

    this.client = new ParakeetStreamingClient(this.log);
    this.startedStreaming = false;

    try {
      await this.client.connect({
        onReady: async () => {
          if (this.startedStreaming) return;
          this.startedStreaming = true;

          this.log('[LectureParakeet] Parakeet ready', LogLevel.SUCCESS);
          this.callbacks?.onConnectionChange(true, false);
          this.callbacks?.onSummaryUpdate([], false);

          try {
            await this.client?.startStream();
            await this.startAudioCapture();
            this.log('[LectureParakeet] Live transcription started', LogLevel.SUCCESS);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.callbacks?.onError(msg);
          }
        },
        onPartial: (text) => this.handlePartial(text),
        onError: (message) => {
          this.log(`[LectureParakeet] ${message}`, LogLevel.ERROR);
          this.callbacks?.onError(message);
          this.callbacks?.onConnectionChange(false, false);
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`[LectureParakeet] Failed to connect: ${msg}`, LogLevel.ERROR);
      this.callbacks?.onError(msg);
      this.callbacks?.onConnectionChange(false, false);
    }
  }

  public pause(): void {
    this.isPaused = true;
    this.log('[LectureParakeet] Paused', LogLevel.INFO);
  }

  public resume(): void {
    this.isPaused = false;
    this.log('[LectureParakeet] Resumed', LogLevel.INFO);
  }

  public generateSummary(): void {
    this.log('[LectureParakeet] Summary disabled (local transcript-only)', LogLevel.INFO);
    this.callbacks?.onSummaryUpdate([], false);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // Finalize any pending fragment so it appears in the history/overlay.
      if (this.pendingText && this.pendingText.trim()) {
        this.transcripts.push({
          id: `t_${Date.now()}_${this.nextId++}`,
          text: this.pendingText.trim(),
          timestampMs: this.pendingTimestampMs,
          isFinal: true,
        });
      }

      this.pendingText = null;
      this.callbacks?.onTranscriptUpdate([...this.transcripts], null);
    } catch {
      // ignore
    }

    try {
      this.client?.stopStream();
    } catch {
      // ignore
    }
    try {
      this.client?.disconnect();
    } catch {
      // ignore
    }
    this.client = null;

    if (this.audioWorklet) {
      try {
        this.audioWorklet.disconnect();
      } catch {
        // ignore
      }
      this.audioWorklet = null;
    }
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }

    this.isRunning = false;
    this.isPaused = false;
    this.mediaStream = null;
    this.startedStreaming = false;
    this.callbacks?.onConnectionChange(false, false);

    this.log('[LectureParakeet] Stopped', LogLevel.INFO);
  }

  private handlePartial(fullTextRaw: string): void {
    const fullText = String(fullTextRaw || '').trim();
    if (!fullText) return;

    let delta = '';
    if (this.lastFullText && fullText.startsWith(this.lastFullText)) {
      delta = fullText.slice(this.lastFullText.length).trim();
    } else if (!this.lastFullText) {
      delta = fullText;
    } else {
      // Worker reset or non-prefix change; treat as a new fragment.
      delta = fullText;
    }
    this.lastFullText = fullText;
    if (!delta) return;

    const ts = this.getElapsedTime();

    // Finalize prior pending fragment into the transcript list.
    if (this.pendingText && this.pendingText.trim()) {
      this.transcripts.push({
        id: `t_${Date.now()}_${this.nextId++}`,
        text: this.pendingText.trim(),
        timestampMs: this.pendingTimestampMs,
        isFinal: true,
      });
    }

    // Keep newest fragment as "current" so the overlay can show it live.
    this.pendingText = delta;
    this.pendingTimestampMs = ts;

    this.callbacks?.onTranscriptUpdate([...this.transcripts], this.pendingText);
  }

  private async startAudioCapture(): Promise<void> {
    if (!this.mediaStream) return;

    const audioTracks = this.mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      this.log('[LectureParakeet] No audio track found', LogLevel.WARN);
      return;
    }

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    await this.audioContext.audioWorklet.addModule('/audio-processor.js');

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.audioWorklet = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');

    this.audioWorklet.port.onmessage = (event) => {
      if (this.isPaused) return;
      const pcmData = event.data.pcmData as Int16Array;
      if (!pcmData || pcmData.length === 0) return;
      this.client?.sendPcmFrame(pcmData.buffer as ArrayBuffer);
    };

    source.connect(this.audioWorklet);
    this.log('[LectureParakeet] Audio capture started', LogLevel.SUCCESS);
  }
}
