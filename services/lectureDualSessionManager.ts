import GeminiVideoSummaryService from './geminiVideoSummaryService';
import ParakeetTranscriptionService, { TranscriptWord } from './parakeetTranscriptionService';
import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

// Transcript entry with timestamp
interface TranscriptEntry {
  id: string;
  text: string;
  timestampMs: number; // Elapsed ms since session start
  isFinal: boolean;
}

// Summary entry with time window info
interface SummaryEntry {
  id: string;
  text: string;
  timestampMs: number;
  windowStart: number; // e.g., 0, 120000, 240000 (ms)
  windowEnd: number;   // e.g., 119999, 239999, 359999 (ms)
  windowLabel: string; // e.g., "0:00-1:59"
}

interface LectureDualSessionCallbacks {
  onTranscriptUpdate: (transcripts: TranscriptEntry[], currentText: string | null) => void;
  onSummaryUpdate: (summaries: SummaryEntry[], isGenerating: boolean) => void;
  onPartialSummary?: (text: string) => void;
  onError: (error: string) => void;
  onConnectionChange: (transcriptConnected: boolean, summaryConnected: boolean) => void;
}

// Configuration
const SUMMARY_WINDOW_MS = 60000;           // 1-minute summary windows

// System instructions
const TRANSCRIPT_SYSTEM_INSTRUCTION = `You are a transcription service. Your ONLY job is to accurately transcribe the audio you hear. Do NOT respond to questions or provide commentary. Stay completely silent - just transcribe.`;

class LectureDualSessionManager {
  private transcriptService: ParakeetTranscriptionService | null = null;
  private summaryService: GeminiVideoSummaryService | null = null;
  private log: LogFunction;
  private callbacks: LectureDualSessionCallbacks | null = null;

  // Session timing
  private sessionStartTime: number = 0;

  // Transcript buffer with timestamps
  private transcriptBuffer: TranscriptEntry[] = [];
  private currentTranscriptText: string | null = null;
  private firstFragmentTimestamp: number | null = null; // Timestamp when first italic text appears

  // Summary state
  private summaries: SummaryEntry[] = [];
  private currentWindowIndex: number = 0;
  private isGeneratingSummary: boolean = false;

  // Intervals
  private autoSummaryIntervalId: number | null = null;

  // Audio capture
  private audioContext: AudioContext | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;

  // Video recording for summary segments
  private mediaRecorder: MediaRecorder | null = null;
  private videoSegmentChunks: Blob[] = [];
  private displayStream: MediaStream | null = null;

  // Media elements (set by session manager)
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;

  // Connection state
  private isRunning: boolean = false;

  constructor(log: LogFunction) {
    this.log = log;
  }

  // Get elapsed time since session start
  public getElapsedTime(): number {
    if (this.sessionStartTime === 0) return 0;
    return Date.now() - this.sessionStartTime;
  }

  // Format timestamp as MM:SS
  public formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // Format time window label (e.g., "0:00-1:59")
  private formatWindowLabel(startMs: number, endMs: number): string {
    return `${this.formatTimestamp(startMs)}-${this.formatTimestamp(endMs)}`;
  }

  // Get transcripts within a time window
  private getTranscriptsInWindow(startMs: number, endMs: number): TranscriptEntry[] {
    return this.transcriptBuffer.filter(t => 
      t.timestampMs >= startMs && t.timestampMs <= endMs && t.isFinal
    );
  }

  // Build context string for a time window
  private buildWindowTranscriptText(startMs: number, endMs: number): string {
    const entries = this.getTranscriptsInWindow(startMs, endMs);
    if (entries.length === 0) return '(no transcript in this window)';
    
    return entries.map(e => `[${this.formatTimestamp(e.timestampMs)}] ${e.text}`).join('\n');
  }

  // Clear all old lecture session handles from localStorage to prevent stale context
  private clearOldLectureSessions(): void {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('gemini_live_session_lecture_transcript') || 
                    key.startsWith('gemini_live_session_lecture_summary'))) {
          keysToRemove.push(key);
        }
      }
      
      for (const key of keysToRemove) {
        localStorage.removeItem(key);
        this.log(`[LectureDual] Cleared old session: ${key}`, LogLevel.INFO);
      }
      
      if (keysToRemove.length > 0) {
        this.log(`[LectureDual] Cleared ${keysToRemove.length} old lecture session(s)`, LogLevel.SUCCESS);
      }
    } catch (error) {
      this.log('[LectureDual] Could not clear old lecture sessions from localStorage', LogLevel.WARN);
    }
  }

  // Initialize both services
  public async start(
    apiKey: string,
    callbacks: LectureDualSessionCallbacks,
    mediaStream: MediaStream,
    videoElement: HTMLVideoElement,
    canvasElement: HTMLCanvasElement
  ): Promise<void> {
    if (this.isRunning) {
      this.log('[LectureDual] Already running', LogLevel.WARN);
      return;
    }

    this.callbacks = callbacks;
    this.mediaStream = mediaStream;
    this.videoElement = videoElement;
    this.canvasElement = canvasElement;
    this.sessionStartTime = Date.now();
    this.transcriptBuffer = [];
    this.summaries = [];
    this.currentWindowIndex = 0;
    this.videoSegmentChunks = [];

    // Clear any old lecture session handles from localStorage
    this.clearOldLectureSessions();

    try {
      // Create Parakeet transcript service (Session 1 - local transcription via WebSocket)
      this.log('[LectureDual] Creating Parakeet transcription service...', LogLevel.INFO);
      this.transcriptService = new ParakeetTranscriptionService(this.log);
      
      // Initialize Parakeet WebSocket server
      await this.transcriptService.initialize({
        onTranscript: (text, isFinal, words) => this.handleTranscript(text, isFinal),
        onError: (error) => {
          this.log(`[LectureDual] Parakeet error: ${error}`, LogLevel.ERROR);
          callbacks.onError(`Transcription: ${error}`);
        },
        onClose: (reason) => {
          this.log(`[LectureDual] Parakeet closed: ${reason}`, LogLevel.WARN);
          callbacks.onConnectionChange(false, this.summaryService?.isReady() ?? false);
        },
      });

      this.log('[LectureDual] Parakeet transcription service connected', LogLevel.SUCCESS);

      // Create summary service (Session 2 - Gemini 2.5 Flash with Files API)
      this.log('[LectureDual] Creating Gemini video summary service...', LogLevel.INFO);
      this.summaryService = new GeminiVideoSummaryService(apiKey, this.log);
      
      if (!this.summaryService.isReady()) {
        throw new Error('Failed to initialize Gemini video summary service');
      }

      this.log('[LectureDual] Summary service initialized', LogLevel.SUCCESS);

      // Start video recording for segments
      await this.startVideoRecording();

      // Start audio capture
      await this.startAudioCapture();

      // Start auto-summary timer
      this.startAutoSummaryTimer();

      this.isRunning = true;
      callbacks.onConnectionChange(true, true);

      this.log('[LectureDual] Dual session started successfully', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[LectureDual] Failed to start: ${message}`, LogLevel.ERROR);
      callbacks.onError(message);
      this.cleanup();
      throw error;
    }
  }

  // Handle transcript from Session 1
  private handleTranscript(text: string, isFinal: boolean): void {
    if (isFinal) {
      // Use the timestamp from when first italic fragment appeared
      const timestampMs = this.firstFragmentTimestamp ?? this.getElapsedTime();
      const entry: TranscriptEntry = {
        id: `transcript_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        text,
        timestampMs,
        isFinal: true,
      };
      this.transcriptBuffer.push(entry);
      this.currentTranscriptText = null;
      // Reset for next turn
      this.firstFragmentTimestamp = null;

      this.log(`[LectureDual] Final transcript at ${this.formatTimestamp(timestampMs)}: "${text.substring(0, 50)}..."`, LogLevel.SUCCESS);
      // Transcript text will be included in the summary request (not streamed anymore)
    } else {
      // Capture timestamp when FIRST italic fragment appears
      if (this.firstFragmentTimestamp === null) {
        this.firstFragmentTimestamp = this.getElapsedTime();
        this.log(`[LectureDual] 🎤 First fragment detected at ${this.formatTimestamp(this.firstFragmentTimestamp)}`, LogLevel.INFO);
      }
      // Update current (in-progress) transcript
      this.currentTranscriptText = text;
    }

    // Notify callback
    this.callbacks?.onTranscriptUpdate(this.transcriptBuffer, this.currentTranscriptText);
  }

  // Start video recording for segment capture
  private async startVideoRecording(): Promise<void> {
    if (!this.mediaStream) {
      this.log('[LectureDual] No media stream for video recording', LogLevel.ERROR);
      return;
    }

    // Get video track from the display stream
    const videoTracks = this.mediaStream.getVideoTracks();
    if (videoTracks.length === 0) {
      this.log('[LectureDual] No video track found for recording', LogLevel.ERROR);
      return;
    }

    try {
      // Create a new stream with just the video track for recording
      this.displayStream = new MediaStream(videoTracks);
      
      // Try VP9 first, fall back to VP8
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') 
        ? 'video/webm;codecs=vp9' 
        : 'video/webm;codecs=vp8';

      this.mediaRecorder = new MediaRecorder(this.displayStream, {
        mimeType,
        videoBitsPerSecond: 500000, // 500kbps for low resolution
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.videoSegmentChunks.push(event.data);
          this.log(`[LectureDual] Video chunk received: ${Math.round(event.data.size / 1024)}KB`, LogLevel.INFO);
        }
      };

      this.mediaRecorder.onerror = (event) => {
        this.log(`[LectureDual] MediaRecorder error: ${event}`, LogLevel.ERROR);
      };

      // Start recording with timeslice to get data regularly
      this.mediaRecorder.start(5000); // Get data every 5 seconds
      this.log(`[LectureDual] Video recording started (${mimeType})`, LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[LectureDual] Failed to start video recording: ${message}`, LogLevel.ERROR);
    }
  }

  // Get current video segment blob and clear chunks
  private getCurrentVideoSegment(): Blob | null {
    if (this.videoSegmentChunks.length === 0) {
      this.log('[LectureDual] No video chunks available', LogLevel.WARN);
      return null;
    }

    const blob = new Blob(this.videoSegmentChunks, { type: 'video/webm' });
    const sizeKB = Math.round(blob.size / 1024);
    this.log(`[LectureDual] Created video segment: ${sizeKB}KB from ${this.videoSegmentChunks.length} chunks`, LogLevel.INFO);
    
    // Clear chunks for next segment (recording continues)
    this.videoSegmentChunks = [];
    
    return blob;
  }

  // Start auto-summary timer
  private startAutoSummaryTimer(): void {
    this.autoSummaryIntervalId = window.setInterval(async () => {
      if (!this.summaryService?.isReady()) return;

      this.log(`[LectureDual] Auto-summary trigger (${SUMMARY_WINDOW_MS / 1000}s interval)`, LogLevel.INFO);
      await this.generateSummary();
    }, SUMMARY_WINDOW_MS);

    this.log(`[LectureDual] Auto-summary timer started (${SUMMARY_WINDOW_MS / 1000}s interval)`, LogLevel.SUCCESS);
  }

  // Start audio capture
  private async startAudioCapture(): Promise<void> {
    if (!this.mediaStream) return;

    const audioTracks = this.mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      this.log('[LectureDual] No audio track found', LogLevel.WARN);
      return;
    }

    try {
      this.audioContext = new AudioContext({ sampleRate: 16000 });

      // Load audio worklet
      await this.audioContext.audioWorklet.addModule('/audio-processor.js');

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.audioWorklet = new AudioWorkletNode(this.audioContext, 'audio-capture-processor');

      this.audioWorklet.port.onmessage = (event) => {
        if (!this.transcriptService?.isConnected()) return;

        // The audio processor sends { pcmData: Int16Array }
        const pcmData = event.data.pcmData as Int16Array;
        const base64Audio = this.arrayBufferToBase64(pcmData.buffer as ArrayBuffer);

        // Send audio to Parakeet transcription service (Session 1) only
        this.transcriptService.sendAudio(base64Audio, 'audio/pcm;rate=16000');
      };

      source.connect(this.audioWorklet);
      // Don't connect to destination to avoid echo

      this.log('[LectureDual] Audio capture started', LogLevel.SUCCESS);
    } catch (error) {
      this.log(`[LectureDual] Audio capture error: ${error}`, LogLevel.ERROR);
    }
  }

  // Helper: Convert ArrayBuffer to base64
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Generate summary for current time window
  public async generateSummary(isPartialWindow: boolean = false): Promise<void> {
    if (!this.summaryService?.isReady()) {
      this.log('[LectureDual] Cannot generate summary - service not ready', LogLevel.WARN);
      return;
    }

    if (this.isGeneratingSummary) {
      this.log('[LectureDual] Summary generation already in progress', LogLevel.WARN);
      return;
    }

    this.currentWindowIndex++;
    const currentWindowStart = (this.currentWindowIndex - 1) * SUMMARY_WINDOW_MS;
    
    // For partial windows, use actual elapsed time instead of full window
    const currentWindowEnd = isPartialWindow 
      ? this.getElapsedTime() 
      : this.currentWindowIndex * SUMMARY_WINDOW_MS - 1;
    
    const currentLabel = this.formatWindowLabel(currentWindowStart, currentWindowEnd);

    // Get transcript text for this window
    const transcriptText = this.buildWindowTranscriptText(currentWindowStart, currentWindowEnd);

    // Get video segment (clears chunks for next segment, recording continues)
    const videoBlob = this.getCurrentVideoSegment();
    if (!videoBlob) {
      this.log('[LectureDual] No video data available for summary', LogLevel.WARN);
      // Still generate summary without video if we have transcript
      if (transcriptText === '(no transcript in this window)') {
        this.log('[LectureDual] No transcript or video - skipping summary', LogLevel.WARN);
        return;
      }
    }

    this.isGeneratingSummary = true;
    this.callbacks?.onSummaryUpdate(this.summaries, true);

    this.log(`[LectureDual] Generating summary for window ${currentLabel}${isPartialWindow ? ' (partial)' : ''}...`, LogLevel.INFO);

    try {
      // Call the new Gemini video summary service
      const result = await this.summaryService.uploadAndSummarize(
        videoBlob || new Blob([], { type: 'video/webm' }),
        transcriptText,
        currentLabel
      );

      if (result.success) {
        const timestampMs = this.getElapsedTime();
        const entry: SummaryEntry = {
          id: `summary_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          text: result.text,
          timestampMs,
          windowStart: currentWindowStart,
          windowEnd: currentWindowEnd,
          windowLabel: currentLabel,
        };

        this.summaries.push(entry);
        this.log(`[LectureDual] Summary complete for window ${currentLabel}`, LogLevel.SUCCESS);
        this.callbacks?.onSummaryUpdate(this.summaries, false);
      } else {
        this.log(`[LectureDual] Summary generation failed: ${result.error}`, LogLevel.ERROR);
        this.callbacks?.onError(`Summary failed: ${result.error}`);
        this.callbacks?.onSummaryUpdate(this.summaries, false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[LectureDual] Summary generation error: ${message}`, LogLevel.ERROR);
      this.callbacks?.onError(`Summary error: ${message}`);
      this.callbacks?.onSummaryUpdate(this.summaries, false);
    } finally {
      this.isGeneratingSummary = false;
    }
  }

  // Audio is now sent directly to Parakeet in audioWorklet.port.onmessage handler
  // No need for sendRealtimeAudio method since Parakeet service handles it internally

  // Pause/resume (for external control)
  public pause(): void {
    // Pause MediaRecorder if recording
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
    if (this.autoSummaryIntervalId) {
      clearInterval(this.autoSummaryIntervalId);
      this.autoSummaryIntervalId = null;
    }
    this.log('[LectureDual] Paused', LogLevel.INFO);
  }

  public resume(): void {
    if (this.isRunning) {
      // Resume MediaRecorder if paused
      if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
        this.mediaRecorder.resume();
      }
      this.startAutoSummaryTimer();
      this.log('[LectureDual] Resumed', LogLevel.INFO);
    }
  }

  // Stop and cleanup
  public async stop(): Promise<void> {
    // Check if we need to generate a final summary (no summaries yet or time < window)
    const elapsedTime = this.getElapsedTime();
    const shouldGenerateFinalSummary = this.currentWindowIndex === 0 && elapsedTime > 0;

    if (shouldGenerateFinalSummary && this.summaryService?.isReady()) {
      this.log(`[LectureDual] Generating final summary for partial window (elapsed: ${Math.round(elapsedTime / 1000)}s)`, LogLevel.INFO);
      
      try {
        // Generate summary with 60-second timeout (video upload can take time)
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Summary generation timeout')), 60000);
        });
        
        await Promise.race([
          this.generateSummary(true),
          timeoutPromise
        ]);
        
        this.log('[LectureDual] Final summary completed', LogLevel.SUCCESS);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.log(`[LectureDual] Final summary failed: ${message}`, LogLevel.WARN);
      }
    }

    await this.cleanup();
    this.log('[LectureDual] Stopped', LogLevel.INFO);
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

    // Stop video recording
    if (this.mediaRecorder) {
      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
      this.mediaRecorder = null;
    }
    this.displayStream = null;
    this.videoSegmentChunks = [];

    // Stop intervals
    if (this.autoSummaryIntervalId) {
      clearInterval(this.autoSummaryIntervalId);
      this.autoSummaryIntervalId = null;
    }

    // Delete all uploaded files from Gemini Files API
    if (this.summaryService) {
      try {
        await this.summaryService.deleteAllUploadedFiles();
        this.log('[LectureDual] Cleaned up uploaded files', LogLevel.SUCCESS);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.log(`[LectureDual] File cleanup error: ${message}`, LogLevel.WARN);
      }
      this.summaryService = null;
    }

    // Disconnect transcript service
    if (this.transcriptService) {
      await this.transcriptService.dispose();
      this.transcriptService = null;
    }

    this.isRunning = false;
    this.callbacks?.onConnectionChange(false, false);
  }

  // Getters
  public getTranscripts(): TranscriptEntry[] {
    return this.transcriptBuffer;
  }

  public getSummaries(): SummaryEntry[] {
    return this.summaries;
  }

  public isTranscriptConnected(): boolean {
    return this.transcriptService?.isConnected() ?? false;
  }

  public isSummaryConnected(): boolean {
    return this.summaryService?.isReady() ?? false;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getIsGeneratingSummary(): boolean {
    return this.isGeneratingSummary;
  }

  public getCurrentWindowIndex(): number {
    return this.currentWindowIndex;
  }
}

export default LectureDualSessionManager;
export type { TranscriptEntry, SummaryEntry, LectureDualSessionCallbacks };
