import LectureLiveApiService from './lectureLiveApiService';
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
const VIDEO_FRAME_INTERVAL_MS = 2000;      // Send video frame every 2 seconds
const SUMMARY_WINDOW_MS = 60000;           // 1-minute summary windows (TODO: Change to 300000 for 5-min after testing)

// System instructions
const TRANSCRIPT_SYSTEM_INSTRUCTION = `You are a transcription service. Your ONLY job is to accurately transcribe the audio you hear. Do NOT respond to questions or provide commentary. Stay completely silent - just transcribe.`;

const SUMMARY_SYSTEM_INSTRUCTION = `You are a lecture summarization assistant observing a live lecture through continuous video and transcript text.

CRITICAL RULES:
- You must ONLY describe content you actually observe in the current video frames
- You must ONLY summarize information from the transcript text you receive in THIS session
- NEVER invent, imagine, or recall content from training data or previous sessions
- If you cannot see content clearly in the frames, say "Unable to clearly see the current slide/screen"
- If you haven't received any transcript text in a time window, say "No transcript received in this window"

You will receive:
1. Continuous transcript text from the lecture (what the lecturer is saying)
2. Continuous video frames showing slides, diagrams, code, or the lecturer

When asked to summarize a time window, organize the content by TOPICS and THEMES:
- Identify main topics and themes discussed in the window
- Group related concepts, examples, and explanations under each topic
- List key visual elements (slides, diagrams, code) that appeared
- Organize your summary with clear topic headers

**Response Format (use markdown):**
- Use **bold** for important terms and key points
- Use *italics* for emphasis
- Use \`inline code\` for variable names, function names, technical terms, etc.
- Use triple backticks with language identifier for code blocks:
  \`\`\`python
  # your code here
  \`\`\`
- Use ### for topic headers
- Use bullet points for lists
- Keep explanations concise but complete`;

class LectureDualSessionManager {
  private transcriptService: LectureLiveApiService | null = null;
  private summaryService: LectureLiveApiService | null = null;
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
  private currentPartialSummary: string = '';
  private summaryCompletionResolve: (() => void) | null = null;

  // Intervals
  private videoFrameIntervalId: number | null = null;
  private autoSummaryIntervalId: number | null = null;

  // Audio capture
  private audioContext: AudioContext | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;

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

    // Generate unique session keys with timestamp to guarantee fresh Gemini sessions
    // This prevents any possibility of Gemini API resuming stale server-side context
    const sessionTimestamp = Date.now();
    const transcriptSessionKey = `lecture_transcript_${sessionTimestamp}`;
    const summarySessionKey = `lecture_summary_${sessionTimestamp}`;

    // Clear any old lecture session handles from localStorage
    this.clearOldLectureSessions();

    try {
      // Create transcript service (Session 1 - audio only)
      this.log(`[LectureDual] Creating transcript service with key: ${transcriptSessionKey}`, LogLevel.INFO);
      this.transcriptService = new LectureLiveApiService(apiKey, this.log, transcriptSessionKey);
      
      // Clear any stale session from previous lectures to start fresh
      this.transcriptService.clearSession();
      
      await this.transcriptService.connect({
        onTranscript: (text, isFinal) => this.handleTranscript(text, isFinal),
        onModelResponse: () => {}, // Transcript service should stay silent
        onPartialResponse: () => {},
        onError: (error) => {
          this.log(`[LectureDual] Transcript service error: ${error}`, LogLevel.ERROR);
          callbacks.onError(`Transcript: ${error}`);
        },
        onClose: (reason) => {
          this.log(`[LectureDual] Transcript service closed: ${reason}`, LogLevel.WARN);
          callbacks.onConnectionChange(false, this.summaryService?.isConnected() ?? false);
        },
        onReconnecting: () => {
          this.log('[LectureDual] Transcript service reconnecting...', LogLevel.INFO);
        },
      }, TRANSCRIPT_SYSTEM_INSTRUCTION);

      this.log('[LectureDual] Transcript service connected', LogLevel.SUCCESS);

      // Create summary service (Session 2 - video + transcript text)
      this.log(`[LectureDual] Creating summary service with key: ${summarySessionKey}`, LogLevel.INFO);
      this.summaryService = new LectureLiveApiService(apiKey, this.log, summarySessionKey);
      
      // Clear any stale session from previous lectures to start fresh
      this.summaryService.clearSession();
      
      await this.summaryService.connect({
        onTranscript: () => {}, // Summary service doesn't receive audio
        onModelResponse: (text) => this.handleSummaryComplete(text),
        onPartialResponse: (text) => this.handlePartialSummary(text),
        onError: (error) => {
          this.log(`[LectureDual] Summary service error: ${error}`, LogLevel.ERROR);
          callbacks.onError(`Summary: ${error}`);
        },
        onClose: (reason) => {
          this.log(`[LectureDual] Summary service closed: ${reason}`, LogLevel.WARN);
          callbacks.onConnectionChange(this.transcriptService?.isConnected() ?? false, false);
        },
        onReconnecting: () => {
          this.log('[LectureDual] Summary service reconnecting...', LogLevel.INFO);
        },
      }, SUMMARY_SYSTEM_INSTRUCTION);

      this.log('[LectureDual] Summary service connected', LogLevel.SUCCESS);
      // Start video frame capture (to summary service only)
      this.startVideoFrameCapture();

      // Start audio capture
      await this.startAudioCapture();

      // Start auto-summary timer
      this.startAutoSummaryTimer();
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
      
      // Send transcript text to summary service (so it has text context without audio)
      if (this.summaryService?.isConnected()) {
        this.summaryService.sendRealtimeText(text);
        this.log(`[LectureDual] Sent transcript to summary service: "${text.substring(0, 50)}..."`, LogLevel.INFO);
      }
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

  // Handle partial summary streaming
  private handlePartialSummary(text: string): void {
    this.currentPartialSummary += text;
    this.callbacks?.onPartialSummary?.(text);
  }

  // Handle complete summary from Session 2
  private handleSummaryComplete(text: string): void {
    if (!this.isGeneratingSummary) {
      // This might be an unexpected model response, log but ignore
      this.log(`[LectureDual] Unexpected model response (not generating summary): "${text.substring(0, 50)}..."`, LogLevel.WARN);
      return;
    }

    const timestampMs = this.getElapsedTime();
    const windowStart = (this.currentWindowIndex - 1) * SUMMARY_WINDOW_MS;
    const windowEnd = this.currentWindowIndex * SUMMARY_WINDOW_MS - 1;

    const entry: SummaryEntry = {
      id: `summary_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      text: text || this.currentPartialSummary,
      timestampMs,
      windowStart,
      windowEnd,
      windowLabel: this.formatWindowLabel(windowStart, windowEnd),
    };

    this.summaries.push(entry);
    this.isGeneratingSummary = false;
    this.currentPartialSummary = '';

    this.log(`[LectureDual] Summary complete for window ${entry.windowLabel}`, LogLevel.SUCCESS);
    this.callbacks?.onSummaryUpdate(this.summaries, false);

    // Resolve promise if waiting
    if (this.summaryCompletionResolve) {
      this.summaryCompletionResolve();
      this.summaryCompletionResolve = null;
    }
  }

  // Start video frame capture (sends to summary service only)
  private startVideoFrameCapture(): void {
    if (!this.videoElement || !this.canvasElement) return;

    this.videoFrameIntervalId = window.setInterval(() => {
      if (!this.summaryService?.isConnected()) return;

      const frame = this.captureVideoFrame();
      if (frame) {
        this.summaryService.sendVideoFrame(frame);
      }
    }, VIDEO_FRAME_INTERVAL_MS);

    this.log(`[LectureDual] Video frame capture started (${VIDEO_FRAME_INTERVAL_MS}ms interval)`, LogLevel.SUCCESS);
  }

  // Capture a video frame as base64 JPEG
  private captureVideoFrame(): string | null {
    if (!this.videoElement || !this.canvasElement) return null;

    const video = this.videoElement;
    const canvas = this.canvasElement;

    // Log video element state for debugging
    this.log(`[LectureDual] Video state: readyState=${video.readyState}, videoWidth=${video.videoWidth}, videoHeight=${video.videoHeight}, paused=${video.paused}`, LogLevel.INFO);

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      this.log('[LectureDual] Video has no dimensions - capture skipped', LogLevel.WARN);
      return null;
    }

    // Scale down for efficiency
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;

    this.log(`[LectureDual] Capturing frame: ${canvas.width}x${canvas.height} (scale=${scale.toFixed(2)})`, LogLevel.INFO);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Get base64 without the data URL prefix
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    
    // Log frame size
    const sizeKB = Math.round(base64Data.length * 3 / 4 / 1024);
    this.log(`[LectureDual] Frame captured: ${sizeKB}KB`, LogLevel.SUCCESS);
    
    return base64Data;
  }

  // Start auto-summary timer (every 2 minutes)
  private startAutoSummaryTimer(): void {
    this.autoSummaryIntervalId = window.setInterval(async () => {
      if (!this.summaryService?.isConnected()) return;

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

        // Send audio to transcript service (Session 1) only
        this.sendRealtimeAudio(base64Audio, 'audio/pcm;rate=16000');
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
    if (!this.summaryService?.isConnected()) {
      this.log('[LectureDual] Cannot generate summary - not connected', LogLevel.WARN);
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

    // Build topic-based prompt (unified for all windows)
    const prompt = `Time window ${currentLabel} has just ended.

Analyze all the audio and visual content from this window and organize your summary by TOPICS:
- Identify main topics/themes discussed
- Group related concepts, examples, and explanations under each topic
- List key visual elements (slides, diagrams, code) that appeared
- Format as clear sections with topic headers

IMPORTANT: First, describe what you can currently SEE on the screen (slides, diagrams, code, text, or the lecturer). Then organize the content you've been HEARING and SEEING by topic.`;

    this.isGeneratingSummary = true;
    this.currentPartialSummary = '';
    this.callbacks?.onSummaryUpdate(this.summaries, true);

    // Create promise that resolves when summary completes
    const summaryPromise = new Promise<void>((resolve) => {
      this.summaryCompletionResolve = resolve;
    });

    // Send prompt with triggerResponse: true to trigger model response
    this.summaryService.sendTextWithOptions(prompt, { triggerResponse: true });

    this.log(`[LectureDual] Summary requested for window ${currentLabel}${isPartialWindow ? ' (partial)' : ''}`, LogLevel.INFO);

    // Wait for summary to complete
    return summaryPromise;
  }

  // Send audio to transcript session ONLY
  // Session 1 (transcript): Uses audio for transcription → sends text to Session 2
  // Session 2 (summary): Uses video + transcript text (no audio)
  public async sendRealtimeAudio(audioData: string, mimeType: string = 'audio/pcm;rate=16000'): Promise<boolean> {
    // Send to transcript service ONLY
    if (this.transcriptService?.isConnected()) {
      return await this.transcriptService.sendRealtimeAudio(audioData, mimeType);
    }

    return false;
  }

  // Pause/resume (for external control)
  public pause(): void {
    // Clear intervals but keep services connected
    if (this.videoFrameIntervalId) {
      clearInterval(this.videoFrameIntervalId);
      this.videoFrameIntervalId = null;
    }
    if (this.autoSummaryIntervalId) {
      clearInterval(this.autoSummaryIntervalId);
      this.autoSummaryIntervalId = null;
    }
    this.log('[LectureDual] Paused', LogLevel.INFO);
  }

  public resume(): void {
    if (this.isRunning) {
      this.startVideoFrameCapture();
      this.startAutoSummaryTimer();
      this.log('[LectureDual] Resumed', LogLevel.INFO);
    }
  }

  // Stop and cleanup
  public async stop(): Promise<void> {
    // Check if we need to generate a final summary (no summaries yet or time < window)
    const elapsedTime = this.getElapsedTime();
    const shouldGenerateFinalSummary = this.currentWindowIndex === 0 && elapsedTime > 0;

    if (shouldGenerateFinalSummary && this.summaryService?.isConnected()) {
      this.log(`[LectureDual] Generating final summary for partial window (elapsed: ${Math.round(elapsedTime / 1000)}s)`, LogLevel.INFO);
      
      try {
        // Generate summary with 10-second timeout
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Summary generation timeout')), 10000);
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

    this.cleanup();
    this.log('[LectureDual] Stopped', LogLevel.INFO);
  }

  private cleanup(): void {
    // Stop audio
    if (this.audioWorklet) {
      this.audioWorklet.disconnect();
      this.audioWorklet = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Stop intervals
    if (this.videoFrameIntervalId) {
      clearInterval(this.videoFrameIntervalId);
      this.videoFrameIntervalId = null;
    }
    if (this.autoSummaryIntervalId) {
      clearInterval(this.autoSummaryIntervalId);
      this.autoSummaryIntervalId = null;
    }

    // Disconnect services
    if (this.transcriptService) {
      this.transcriptService.disconnect();
      this.transcriptService = null;
    }
    if (this.summaryService) {
      this.summaryService.disconnect();
      this.summaryService = null;
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
    return this.summaryService?.isConnected() ?? false;
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
