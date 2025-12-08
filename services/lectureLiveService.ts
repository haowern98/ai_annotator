/**
 * @deprecated This file is deprecated. Use LectureDualSessionManager instead.
 * 
 * The single-session approach has been replaced with a dual-session architecture:
 * - Session 1: Transcript service (audio only)
 * - Session 2: Summary service (video frames + transcript text)
 * 
 * See: services/lectureDualSessionManager.ts
 */

import {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
  Blob as GenAIBlob,
} from '@google/genai';
import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

interface LectureLiveCallbacks {
  onTranscript: (text: string, isFinal: boolean, timestamp: number) => void;
  onSummary: (text: string, timestamp: number) => void;
  onPartialSummary?: (text: string) => void;
  onError: (error: string) => void;
  onClose: (reason: string) => void;
  onReconnecting?: () => void;
}

// Correct model for Live API
const MODEL_NAME = 'gemini-2.5-flash-live-preview';

// System instruction for lecture summarization
const LECTURE_SYSTEM_INSTRUCTION = `You are a lecture summarization assistant. You are observing a live lecture through screen capture and audio.

When asked to generate a summary, provide a concise but comprehensive summary of what has been discussed in the lecture so far. Focus on:
- Key concepts and definitions
- Important examples or demonstrations
- Main points being taught
- Any formulas, code, or diagrams shown on screen

Keep summaries clear and organized. Use bullet points when appropriate.`;

class LectureLiveService {
  private session: Session | undefined = undefined;
  private ai: GoogleGenAI;
  private log: LogFunction;
  private isIntentionallyClosing = false;
  private currentSummary = '';

  // Session timing
  private sessionStartTime: number = 0;

  // Session resumption state
  private sessionHandleKey: string;
  private currentSessionHandle: string | null = null;

  // Reconnection state
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectTimeoutId: number | null = null;
  private currentCallbacks: LectureLiveCallbacks | null = null;
  private hasRetriedWithFreshSession = false;

  // Track current turn state for transcript accumulation
  private isUserSpeaking = false;
  private accumulatedTranscript = '';
  private fragmentCounter = 0;
  private turnStartTime = 0; // When current transcript turn started

  // Smart buffer flush configuration (same as interview mode)
  private readonly FLUSH_CHECK_START_CHARS = 250;
  private readonly FLUSH_FORCE_CHARS = 350;
  private readonly SENTENCE_END_PATTERN = /[.?!]$/;
  private readonly COMMA_PATTERN = /,$/;
  private readonly LANGUAGE_HINT = "Continue transcribing in English.";

  // Summary generation state
  private isGeneratingSummary = false;

  constructor(apiKey: string, log: LogFunction) {
    if (!apiKey) {
      log("API key is missing.", LogLevel.ERROR);
      throw new Error("API key is missing.");
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.log = log;
    this.sessionHandleKey = 'gemini_live_session_lecture';
    this.loadSessionHandle();
  }

  private loadSessionHandle(): void {
    try {
      const savedHandle = localStorage.getItem(this.sessionHandleKey);
      if (savedHandle) {
        this.currentSessionHandle = savedHandle;
        this.log(`[Lecture] Loaded existing session handle: ${savedHandle.substring(0, 8)}...`, LogLevel.INFO);
      }
    } catch (error) {
      this.log(`[Lecture] Could not load session handle from localStorage`, LogLevel.WARN);
    }
  }

  private saveSessionHandle(handle: string): void {
    try {
      localStorage.setItem(this.sessionHandleKey, handle);
      this.currentSessionHandle = handle;
      this.log(`[Lecture] Saved session handle: ${handle.substring(0, 8)}...`, LogLevel.SUCCESS);
    } catch (error) {
      this.log(`[Lecture] Could not save session handle to localStorage`, LogLevel.WARN);
    }
  }

  private clearSessionHandle(): void {
    try {
      localStorage.removeItem(this.sessionHandleKey);
      this.currentSessionHandle = null;
      this.log(`[Lecture] Cleared session handle`, LogLevel.INFO);
    } catch (error) {
      this.log(`[Lecture] Could not clear session handle from localStorage`, LogLevel.WARN);
    }
  }

  // Get elapsed time since session start in milliseconds
  public getElapsedTime(): number {
    if (this.sessionStartTime === 0) return 0;
    return Date.now() - this.sessionStartTime;
  }

  // Format timestamp as [MM:SS]
  public formatTimestamp(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
  }

  public async connect(callbacks: LectureLiveCallbacks, resumeHandle?: string | null): Promise<void> {
    if (this.session) {
      this.log("Session already exists. Disconnect first.", LogLevel.WARN);
      return;
    }

    this.isIntentionallyClosing = false;
    this.currentCallbacks = callbacks;
    this.hasRetriedWithFreshSession = false;
    this.sessionStartTime = Date.now();

    const handleToUse = resumeHandle !== undefined ? resumeHandle : this.currentSessionHandle;

    const config = {
      responseModalities: [Modality.TEXT],
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      inputAudioTranscription: {},
      voiceActivityDetection: {
        threshold: 0.5,
      },
      contextWindowCompression: {
        triggerTokens: '25600',
        slidingWindow: { targetTokens: '12800' },
      },
      sessionResumption: handleToUse ? { handle: handleToUse } : {},
      systemInstruction: LECTURE_SYSTEM_INSTRUCTION,
    };

    try {
      if (handleToUse) {
        this.log(`[Lecture] Attempting to resume session with handle: ${handleToUse.substring(0, 8)}...`);
      } else {
        this.log(`[Lecture] Starting new session...`);
      }

      this.session = await this.ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            if (handleToUse) {
              this.log(`[Lecture] Connection resumed successfully.`, LogLevel.SUCCESS);
            } else {
              this.log(`[Lecture] New connection opened successfully.`, LogLevel.SUCCESS);
            }
            this.reconnectAttempts = 0;
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleMessage(message, callbacks);
          },
          onerror: (e: ErrorEvent) => {
            this.log(`[Lecture] Session error: ${e.message}`, LogLevel.ERROR);
            callbacks.onError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.handleClose(e, callbacks);
          },
        },
        config,
      });

      this.log("[Lecture] Session object assigned. Connection is fully ready.", LogLevel.SUCCESS);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error during connection.";

      if (errorMessage.includes('session not found') || errorMessage.includes('not found')) {
        this.log(`[Lecture] Session handle invalid or expired. Starting fresh session.`, LogLevel.WARN);
        this.clearSessionHandle();

        if (handleToUse && this.reconnectAttempts === 0) {
          this.reconnectAttempts++;
          return this.connect(callbacks, null);
        }
      }

      this.log(`[Lecture] Connection failed: ${errorMessage}`, LogLevel.ERROR);
      callbacks.onError(errorMessage);
      throw new Error(errorMessage);
    }
  }

  private handleMessage(message: LiveServerMessage, callbacks: LectureLiveCallbacks): void {
    // Handle session resumption updates
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) {
        this.saveSessionHandle(update.newHandle);
        this.log(`[Lecture] Session handle updated: ${update.newHandle.substring(0, 8)}...`, LogLevel.INFO);
      }
    }

    // Handle GoAway message
    if (message.goAway) {
      const timeLeft = message.goAway.timeLeft || 'unknown';
      this.log(`[Lecture] ⚠️ Connection will close in ${timeLeft}. Preparing to reconnect...`, LogLevel.WARN);
    }

    // Handle inputTranscription - accumulate word fragments in real-time
    if (message.serverContent) {
      const serverContentAny = message.serverContent as any;
      if (serverContentAny.inputTranscription) {
        const transcript = serverContentAny.inputTranscription;
        const fragmentText = transcript.text || '';

        this.fragmentCounter++;

        // Check if this is the start of a new turn
        const isNewTurn = !this.isUserSpeaking && fragmentText.length > 0;

        if (isNewTurn) {
          this.isUserSpeaking = true;
          this.accumulatedTranscript = fragmentText;
          this.fragmentCounter = 1;
          this.turnStartTime = this.getElapsedTime();
          this.log(`[Lecture] 🎤 NEW TURN STARTED at ${this.formatTimestamp(this.turnStartTime)}`, LogLevel.SUCCESS);
        } else if (this.isUserSpeaking) {
          this.accumulatedTranscript += fragmentText;
        }

        // Send accumulated text to callback for real-time display (not final)
        if (this.accumulatedTranscript.length > 0) {
          callbacks.onTranscript(this.accumulatedTranscript, false, this.turnStartTime);
        }

        // Smart buffer flush at 250 chars
        if (this.isUserSpeaking && this.accumulatedTranscript.length >= this.FLUSH_CHECK_START_CHARS) {
          const trimmedTranscript = this.accumulatedTranscript.trimEnd();
          const shouldFlushOnSentenceEnd = this.SENTENCE_END_PATTERN.test(trimmedTranscript);
          const shouldFlushOnComma = this.accumulatedTranscript.length >= this.FLUSH_FORCE_CHARS && this.COMMA_PATTERN.test(trimmedTranscript);

          if (shouldFlushOnSentenceEnd || shouldFlushOnComma) {
            this.log(`[Lecture] 🔄 Smart buffer flush at ${this.accumulatedTranscript.length} chars`, LogLevel.INFO);
            this.session?.sendRealtimeInput({ audioStreamEnd: true });
            this.injectPostFlushContext();
          }
        }
      }
    }

    // Handle model content (streaming summaries)
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.text) {
          this.currentSummary += part.text;
          if (callbacks.onPartialSummary) {
            callbacks.onPartialSummary(part.text);
          }
        }
      }
    }

    // Handle turn complete
    if (message.serverContent?.turnComplete) {
      // Finalize accumulated user transcript
      if (this.isUserSpeaking && this.accumulatedTranscript.length > 0) {
        this.log(`[Lecture] ✅ TURN COMPLETE - Final transcript at ${this.formatTimestamp(this.turnStartTime)}`, LogLevel.SUCCESS);
        callbacks.onTranscript(this.accumulatedTranscript, true, this.turnStartTime);
        this.isUserSpeaking = false;
        this.accumulatedTranscript = '';
      }

      // Handle summary completion
      if (this.currentSummary.trim() && this.isGeneratingSummary) {
        const timestamp = this.getElapsedTime();
        callbacks.onSummary(this.currentSummary.trim(), timestamp);
        this.log(`[Lecture] Summary generated at ${this.formatTimestamp(timestamp)}`, LogLevel.SUCCESS);
        this.currentSummary = '';
        this.isGeneratingSummary = false;
      }
    }

    // Handle interruptions
    if (message.serverContent?.interrupted) {
      this.log("[Lecture] Model response interrupted.", LogLevel.INFO);
    }
  }

  private handleClose(e: CloseEvent, callbacks: LectureLiveCallbacks): void {
    if (this.isIntentionallyClosing) {
      this.log("[Lecture] Session disconnected successfully.", LogLevel.SUCCESS);
      this.session = undefined;
    } else {
      const closeReason = e.reason || 'Connection timeout (~10 min limit)';
      this.log(`[Lecture] Session closed unexpectedly. Reason: ${closeReason}`, LogLevel.WARN);
      this.session = undefined;

      const isInvalidSession = closeReason.includes('session not found') ||
                               closeReason.includes('BidiGenerateContent session not found') ||
                               closeReason.includes('not found');

      if (isInvalidSession && this.currentSessionHandle) {
        this.log(`[Lecture] Session handle is invalid or expired. Clearing it.`, LogLevel.WARN);
        this.clearSessionHandle();

        if (!this.hasRetriedWithFreshSession) {
          this.hasRetriedWithFreshSession = true;
          this.log(`[Lecture] Retrying with fresh session...`, LogLevel.INFO);
          this.reconnectAttempts = 0;
          this.attemptReconnection(callbacks);
          return;
        } else {
          callbacks.onClose('Invalid session handle - fresh session failed');
          return;
        }
      }

      if (this.currentSessionHandle && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.attemptReconnection(callbacks);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.log(`[Lecture] Max reconnection attempts reached. Giving up.`, LogLevel.ERROR);
        this.clearSessionHandle();
        callbacks.onClose(e.reason || 'Max reconnection attempts reached');
      } else {
        callbacks.onClose(e.reason || 'Unknown');
      }
    }
  }

  private attemptReconnection(callbacks: LectureLiveCallbacks): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);

    this.log(`[Lecture] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`, LogLevel.INFO);

    if (callbacks.onReconnecting) {
      callbacks.onReconnecting();
    }

    this.reconnectTimeoutId = window.setTimeout(async () => {
      try {
        await this.connect(callbacks, this.currentSessionHandle);
      } catch (error) {
        this.log(`[Lecture] Reconnection attempt ${this.reconnectAttempts} failed.`, LogLevel.ERROR);

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.clearSessionHandle();
          callbacks.onError('Failed to reconnect after multiple attempts');
        }
      }
    }, delay);
  }

  private injectPostFlushContext(): void {
    if (!this.session) return;

    try {
      this.session.sendClientContent({
        turns: [{ parts: [{ text: this.LANGUAGE_HINT }] }],
        turnComplete: false,
      });
      this.log(`[Lecture] 💬 Injected post-flush language hint`, LogLevel.INFO);
    } catch (error) {
      this.log(`[Lecture] Error injecting post-flush context`, LogLevel.WARN);
    }
  }

  // Send audio in real-time
  public async sendRealtimeAudio(audioData: string, mimeType: string = 'audio/pcm;rate=16000'): Promise<boolean> {
    if (!this.session) return false;

    try {
      const audioBlob: GenAIBlob = {
        mimeType: mimeType,
        data: audioData,
      };

      await this.session.sendRealtimeInput({ audio: audioBlob });
      return true;
    } catch (error) {
      this.log(`[Lecture] Error sending audio: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
      return false;
    }
  }

  // Send video frame
  public async sendVideoFrame(base64Image: string): Promise<void> {
    if (!this.session) {
      this.log("[Lecture] Cannot send frame. Session is not connected.", LogLevel.ERROR);
      return;
    }

    try {
      const imageBlob: GenAIBlob = {
        mimeType: 'image/jpeg',
        data: base64Image,
      };

      await this.session.sendRealtimeInput({ media: imageBlob });
    } catch (error) {
      this.log(`[Lecture] Error sending video frame: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  // Request a summary generation
  public async generateSummary(): Promise<void> {
    if (!this.session) {
      this.log("[Lecture] Cannot generate summary. Session is not connected.", LogLevel.ERROR);
      return;
    }

    if (this.isGeneratingSummary) {
      this.log("[Lecture] Summary generation already in progress.", LogLevel.WARN);
      return;
    }

    try {
      this.isGeneratingSummary = true;
      this.currentSummary = '';

      this.session.sendClientContent({
        turns: [{
          parts: [{ text: "Please provide a concise summary of the lecture content discussed so far. Focus on the key concepts, important points, and any examples or demonstrations shown." }],
        }],
        turnComplete: true,
      });

      this.log(`[Lecture] Summary requested at ${this.formatTimestamp(this.getElapsedTime())}`, LogLevel.INFO);
    } catch (error) {
      this.isGeneratingSummary = false;
      this.log(`[Lecture] Error requesting summary: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  public async endAudioStream(): Promise<void> {
    if (!this.session) return;

    try {
      await this.session.sendRealtimeInput({ audioStreamEnd: true });
      this.log("[Lecture] Audio stream end signal sent.");
    } catch (error) {
      this.log(`[Lecture] Error ending audio stream: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  public disconnect(): void {
    if (this.reconnectTimeoutId) {
      window.clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    if (this.session) {
      this.log(`[Lecture] Disconnecting session intentionally.`, LogLevel.INFO);
      this.isIntentionallyClosing = true;
      this.currentSummary = '';
      this.session.close();
      this.session = undefined;
    }
  }

  public clearSession(): void {
    this.disconnect();
    this.clearSessionHandle();
    this.reconnectAttempts = 0;
    this.sessionStartTime = 0;
    this.log(`[Lecture] Session cleared completely.`, LogLevel.INFO);
  }

  public isConnected(): boolean {
    return !!this.session;
  }

  public getSessionHandle(): string | null {
    return this.currentSessionHandle;
  }

  public isGenerating(): boolean {
    return this.isGeneratingSummary;
  }
}

export default LectureLiveService;
