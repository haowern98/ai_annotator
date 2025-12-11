import LocalModelWebSocketService from './localModelWebSocketService';
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
const VIDEO_FRAME_INTERVAL_MS = 2000;      // Capture video frame every 2 seconds
const SUMMARY_WINDOW_MS = 60000;           // 1-minute summary windows (TODO: Change to 300000 for 5-min after testing)
const AUDIO_BUFFER_DURATION_MS = 8000;     // Buffer 8 seconds of audio before transcription
const AUDIO_CHUNK_SIZE_MS = 100;           // Audio worklet sends 100ms chunks

// Calculate how many audio chunks we need to buffer
const CHUNKS_PER_BUFFER = AUDIO_BUFFER_DURATION_MS / AUDIO_CHUNK_SIZE_MS; // 80 chunks for 8 seconds

// Summary system instruction (passed to Gemma model)
const SUMMARY_SYSTEM_INSTRUCTION = `You are a lecture summarization assistant observing a live lecture through continuous video and transcript text.

CRITICAL RULES:
- You must ONLY describe content you actually observe in the current video frames
- You must ONLY summarize information from the transcript text you receive in THIS session
- NEVER invent, imagine, or recall content from training data or previous sessions
- If you cannot see content clearly in the frames, say "Unable to clearly see the current slide/screen"
- If you haven't received any transcript text in a time window, say "No transcript received in this window"

You will receive:
1. Transcript text from the lecture (what the lecturer is saying)
2. Video frames showing slides, diagrams, code, or the lecturer

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
  private websocketService: LocalModelWebSocketService | null = null;
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

  // Audio capture and buffering
  private audioContext: AudioContext | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private audioChunkBuffer: string[] = []; // Buffer for 8-second audio chunks

  // Video frame accumulation for batch summarization
  private videoFrameBuffer: string[] = []; // Accumulated base64 video frames

  // Media elements (set by session manager)
  private videoElement: HTMLVideoElement | null = null;
  private canvasElement: HTMLCanvasElement | null = null;

  // Connection state
  private isRunning: boolean = false;
  private isConnected: boolean = false;

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

  // Buffer audio chunk and send to transcription when buffer is full
  private async bufferAndTranscribeAudio(audioBase64: string): Promise<void> {
    this.audioChunkBuffer.push(audioBase64);

    // Wait until we have 8 seconds of audio (80 chunks of 100ms each)
    if (this.audioChunkBuffer.length >= CHUNKS_PER_BUFFER) {
      const bufferedAudio = this.audioChunkBuffer.join(''); // Concatenate all chunks
      this.audioChunkBuffer = []; // Reset buffer

      this.log(`[LectureDual] Sending 8s audio buffer for transcription (${this.audioChunkBuffer.length} chunks)`, LogLevel.INFO);

      try {
        // Send to Parakeet for transcription (chunk ID is managed internally)
        const transcriptText = await this.websocketService!.transcribeAudio(bufferedAudio);
        
        if (transcriptText && transcriptText.trim().length > 0) {
          // Handle the final transcript
          this.handleTranscript(transcriptText, true);
        } else {
          this.log(`[LectureDual] Empty transcript received`, LogLevel.WARN);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.log(`[LectureDual] Transcription error: ${message}`, LogLevel.ERROR);
        this.callbacks?.onError(`Transcription: ${message}`);
      }
    }
  }

  // Initialize WebSocket service with local models
  public async start(
    apiKey: string, // Unused, kept for backward compatibility
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
    this.audioChunkBuffer = [];
    this.videoFrameBuffer = [];

    try {
      // Create WebSocket service for local models (Parakeet + Gemma)
      this.log('[LectureDual] Connecting to local model WebSocket server...', LogLevel.INFO);
      this.websocketService = new LocalModelWebSocketService(this.log);
      
      await this.websocketService.connect({
        onTranscript: (text, chunkId) => {
          // Parakeet transcription result
          this.log(`[LectureDual] Transcript received (chunkId: ${chunkId}): "${text.substring(0, 50)}..."`, LogLevel.SUCCESS);
          // Handle as final transcript since Parakeet processes complete 8s chunks
          this.handleTranscript(text, true);
        },
        onSummaryChunk: (text) => {
          // Gemma streaming summary chunk
          this.handlePartialSummary(text);
        },
        onSummaryComplete: () => {
          // Gemma finished streaming
          this.handleSummaryComplete(this.currentPartialSummary);
        },
        onError: (error) => {
          this.log(`[LectureDual] WebSocket error: ${error}`, LogLevel.ERROR);
          callbacks.onError(error);
        },
        onClose: (reason) => {
          this.log(`[LectureDual] WebSocket closed: ${reason}`, LogLevel.WARN);
          this.isConnected = false;
          callbacks.onConnectionChange(false, false);
        },
        onReconnecting: () => {
          this.log('[LectureDual] WebSocket reconnecting...', LogLevel.INFO);
          this.isConnected = false;
          callbacks.onConnectionChange(false, false);
        },
      });

      this.isConnected = true;
      this.log('[LectureDual] WebSocket service connected', LogLevel.SUCCESS);

      // Start video frame capture (accumulates frames for batch summarization)
      this.startVideoFrameCapture();

      // Start audio capture (buffers to 8s chunks before transcription)
      await this.startAudioCapture();

      // Start auto-summary timer
      this.startAutoSummaryTimer();

      this.isRunning = true;
      callbacks.onConnectionChange(true, true);

      this.log('[LectureDual] Lecture session started successfully with local models', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[LectureDual] Failed to start: ${message}`, LogLevel.ERROR);
      callbacks.onError(message);
      this.cleanup();
      throw error;
    }
  }

  // Handle transcript from Parakeet model
  private handleTranscript(text: string, isFinal: boolean): void {
    if (isFinal) {
      const timestampMs = this.getElapsedTime();
      const entry: TranscriptEntry = {
        id: `transcript_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        text,
        timestampMs,
        isFinal: true,
      };
      this.transcriptBuffer.push(entry);
      this.currentTranscriptText = null;

      this.log(`[LectureDual] Final transcript at ${this.formatTimestamp(timestampMs)}: "${text.substring(0, 50)}..."`, LogLevel.SUCCESS);
    } else {
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

  // Handle complete summary from Gemma model
  private handleSummaryComplete(fullText: string): void {
    if (!this.isGeneratingSummary) {
      this.log(`[LectureDual] Unexpected summary completion (not generating)`, LogLevel.WARN);
      return;
    }

    const timestampMs = this.getElapsedTime();
    const windowStart = (this.currentWindowIndex - 1) * SUMMARY_WINDOW_MS;
    const windowEnd = this.currentWindowIndex * SUMMARY_WINDOW_MS - 1;

    const entry: SummaryEntry = {
      id: `summary_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      text: fullText,
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

  // Start video frame capture (accumulates frames for batch summarization)
  private startVideoFrameCapture(): void {
    if (!this.videoElement || !this.canvasElement) return;

    this.videoFrameIntervalId = window.setInterval(() => {
      if (!this.isConnected) return;

      const frame = this.captureVideoFrame();
      if (frame) {
        // Accumulate frames instead of sending immediately
        this.videoFrameBuffer.push(frame);
        this.log(`[LectureDual] Video frame captured (buffer: ${this.videoFrameBuffer.length} frames)`, LogLevel.INFO);
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

  // Start auto-summary timer (every 1 minute)
  private startAutoSummaryTimer(): void {
    this.autoSummaryIntervalId = window.setInterval(async () => {
      if (!this.isConnected) return;

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
        if (!this.isConnected) return;

        // The audio processor sends { pcmData: Int16Array }
        const pcmData = event.data.pcmData as Int16Array;
        const base64Audio = this.arrayBufferToBase64(pcmData.buffer as ArrayBuffer);

        // Buffer audio chunks (8 seconds) before sending to Parakeet
        this.bufferAndTranscribeAudio(base64Audio);
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

  // Generate summary for current time window using Gemma model
  public async generateSummary(isPartialWindow: boolean = false): Promise<void> {
    if (!this.isConnected || !this.websocketService) {
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

    // Get transcripts for this window
    const windowTranscripts = this.getTranscriptsInWindow(currentWindowStart, currentWindowEnd);
    const transcriptTexts = windowTranscripts.map(t => 
      `[${this.formatTimestamp(t.timestampMs)}] ${t.text}`
    );

    // Get accumulated video frames
    const videoFrames = [...this.videoFrameBuffer]; // Copy array
    this.videoFrameBuffer = []; // Reset buffer for next window

    this.log(`[LectureDual] Generating summary for window ${currentLabel}: ${transcriptTexts.length} transcripts, ${videoFrames.length} video frames`, LogLevel.INFO);

    if (transcriptTexts.length === 0 && videoFrames.length === 0) {
      this.log('[LectureDual] No content to summarize - skipping', LogLevel.WARN);
      return;
    }

    // Build user prompt for Gemma
    const userPrompt = `Time window ${currentLabel} has just ended.

Analyze all the audio and visual content from this window and organize your summary by TOPICS:
- Identify main topics/themes discussed
- Group related concepts, examples, and explanations under each topic
- List key visual elements (slides, diagrams, code) that appeared
- Format as clear sections with topic headers

IMPORTANT: First, describe what you can SEE in the video frames (slides, diagrams, code, text, or the lecturer). Then organize the content by topic.`;

    this.isGeneratingSummary = true;
    this.currentPartialSummary = '';
    this.callbacks?.onSummaryUpdate(this.summaries, true);

    // Create promise that resolves when summary completes
    const summaryPromise = new Promise<void>((resolve) => {
      this.summaryCompletionResolve = resolve;
    });

    try {
      // Send to Gemma for summarization (with system instruction)
      await this.websocketService.generateSummary(
        transcriptTexts,
        videoFrames,
        SUMMARY_SYSTEM_INSTRUCTION,
        userPrompt
      );

      this.log(`[LectureDual] Summary request sent for window ${currentLabel}${isPartialWindow ? ' (partial)' : ''}`, LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[LectureDual] Summary generation error: ${message}`, LogLevel.ERROR);
      this.callbacks?.onError(`Summary: ${message}`);
      this.isGeneratingSummary = false;
      
      if (this.summaryCompletionResolve) {
        this.summaryCompletionResolve();
        this.summaryCompletionResolve = null;
      }
    }

    // Wait for summary to complete
    return summaryPromise;
  }

  // Legacy method - now handled by audio buffering
  public async sendRealtimeAudio(audioData: string, mimeType: string = 'audio/pcm;rate=16000'): Promise<boolean> {
    // Audio is now buffered and sent in 8-second chunks via bufferAndTranscribeAudio()
    return this.isConnected;
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

    if (shouldGenerateFinalSummary && this.isConnected) {
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

    // Disconnect WebSocket service
    if (this.websocketService) {
      this.websocketService.disconnect();
      this.websocketService = null;
    }

    // Clear buffers
    this.audioChunkBuffer = [];
    this.videoFrameBuffer = [];

    this.isRunning = false;
    this.isConnected = false;
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
    return this.isConnected;
  }

  public isSummaryConnected(): boolean {
    return this.isConnected;
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
