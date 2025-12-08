/**
 * Lecture-specific Live API Service
 * 
 * This is a separate service for Lecture Mode ONLY.
 * It does NOT affect Interview Mode which uses liveApiService.ts
 * 
 * Key differences from liveApiService.ts:
 * - sendTextWithOptions() method for controlling turnComplete flag
 */

import {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
  Part,
  Blob as GenAIBlob,
} from '@google/genai';
import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

interface LectureLiveApiCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
  onNewTurnStart?: () => void;
  onBufferFlush?: () => void;
  onModelResponse: (text: string) => void;
  onPartialResponse?: (text: string) => void;
  onModelTurnStart?: () => void;
  onError: (error: string) => void;
  onClose: (reason: string) => void;
  onReconnecting?: () => void;
}

// Correct model for Live API
const MODEL_NAME = 'gemini-2.5-flash-live-preview';

class LectureLiveApiService {
  private session: Session | undefined = undefined;
  private ai: GoogleGenAI;
  private log: LogFunction;
  private isIntentionallyClosing = false;
  private currentMessage = '';

  // Session resumption state
  private sessionHandleKey: string;
  private currentSessionHandle: string | null = null;

  // Reconnection state
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectTimeoutId: number | null = null;
  private currentCallbacks: LectureLiveApiCallbacks | null = null;
  private currentSystemInstruction: string | undefined = undefined;
  private hasRetriedWithFreshSession = false;

  // Track if we've already signaled the start of this turn
  private hasSignaledTurnStart = false;

  // Track current turn state for transcript accumulation
  private isUserSpeaking = false;
  private accumulatedTranscript = '';
  private fragmentCounter = 0;

  // Smart buffer flush configuration
  private readonly FLUSH_CHECK_START_CHARS = 250;
  private readonly FLUSH_FORCE_CHARS = 350;
  private readonly SENTENCE_END_PATTERN = /[.?!]$/;
  private readonly COMMA_PATTERN = /,$/;
  private readonly LANGUAGE_HINT = "Continue transcribing in English.";

  constructor(apiKey: string, log: LogFunction, sessionKey: string = 'lecture_default') {
    if (!apiKey) {
      log("API key is missing.", LogLevel.ERROR);
      throw new Error("API key is missing.");
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.log = log;
    
    // Create unique session handle key for this service instance
    this.sessionHandleKey = `gemini_live_session_${sessionKey}`;
    
    this.loadSessionHandle();
  }
  
  private loadSessionHandle(): void {
    try {
      const savedHandle = localStorage.getItem(this.sessionHandleKey);
      if (savedHandle) {
        this.currentSessionHandle = savedHandle;
        this.log(`[${this.sessionHandleKey}] Loaded existing session handle: ${savedHandle.substring(0, 8)}...`, LogLevel.INFO);
      }
    } catch (error) {
      this.log(`[${this.sessionHandleKey}] Could not load session handle from localStorage`, LogLevel.WARN);
    }
  }
  
  private saveSessionHandle(handle: string): void {
    try {
      localStorage.setItem(this.sessionHandleKey, handle);
      this.currentSessionHandle = handle;
      this.log(`[${this.sessionHandleKey}] Saved session handle: ${handle.substring(0, 8)}...`, LogLevel.SUCCESS);
    } catch (error) {
      this.log(`[${this.sessionHandleKey}] Could not save session handle to localStorage`, LogLevel.WARN);
    }
  }
  
  private clearSessionHandle(): void {
    try {
      localStorage.removeItem(this.sessionHandleKey);
      this.currentSessionHandle = null;
      this.log(`[${this.sessionHandleKey}] Cleared session handle`, LogLevel.INFO);
    } catch (error) {
      this.log(`[${this.sessionHandleKey}] Could not clear session handle from localStorage`, LogLevel.WARN);
    }
  }

  public async connect(callbacks: LectureLiveApiCallbacks, systemInstruction?: string, resumeHandle?: string | null): Promise<void> {
    if (this.session) {
      this.log("Session already exists. Disconnect first.", LogLevel.WARN);
      return;
    }

    this.isIntentionallyClosing = false;
    this.currentCallbacks = callbacks;
    this.currentSystemInstruction = systemInstruction;
    this.hasRetriedWithFreshSession = false;
    
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
      systemInstruction: systemInstruction || "You are a lecture assistant.",
    };

    try {
      if (handleToUse) {
        this.log(`[${this.sessionHandleKey}] Attempting to resume session with handle: ${handleToUse.substring(0, 8)}...`);
      } else {
        this.log(`[${this.sessionHandleKey}] Starting new session...`);
      }
      
      this.session = await this.ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            if (handleToUse) {
              this.log(`[${this.sessionHandleKey}] Connection resumed successfully with previous context.`, LogLevel.SUCCESS);
            } else {
              this.log(`[${this.sessionHandleKey}] New connection opened successfully.`, LogLevel.SUCCESS);
            }
            this.reconnectAttempts = 0;
          },
          onmessage: (message: LiveServerMessage) => {
            // Handle session resumption updates
            if (message.sessionResumptionUpdate) {
              const update = message.sessionResumptionUpdate;
              if (update.resumable && update.newHandle) {
                this.saveSessionHandle(update.newHandle);
                this.log(`[${this.sessionHandleKey}] Session handle updated: ${update.newHandle.substring(0, 8)}...`, LogLevel.INFO);
              }
            }

            // Handle GoAway message
            if (message.goAway) {
              const timeLeft = message.goAway.timeLeft || 'unknown';
              this.log(`[${this.sessionHandleKey}] ⚠️ Connection will close in ${timeLeft}. Preparing to reconnect...`, LogLevel.WARN);
            }

            // Handle inputTranscription
            if (message.serverContent) {
              const serverContentAny = message.serverContent as any;
              if (serverContentAny.inputTranscription) {
                const transcript = serverContentAny.inputTranscription;
                const fragmentText = transcript.text || '';

                this.fragmentCounter++;

                const isNewTurn = !this.isUserSpeaking && fragmentText.length > 0;

                if (isNewTurn) {
                  this.isUserSpeaking = true;
                  this.accumulatedTranscript = fragmentText;
                  this.fragmentCounter = 1;
                  this.log(`🎤 NEW TURN STARTED with: "${fragmentText}"`, LogLevel.SUCCESS);
                  if (callbacks.onNewTurnStart) {
                    callbacks.onNewTurnStart();
                  }
                } else if (this.isUserSpeaking) {
                  this.accumulatedTranscript += fragmentText;
                }

                if (this.accumulatedTranscript.length > 0) {
                  callbacks.onTranscript(this.accumulatedTranscript, false);
                }

                // Smart buffer flush
                if (this.isUserSpeaking && this.accumulatedTranscript.length >= this.FLUSH_CHECK_START_CHARS) {
                  const trimmedTranscript = this.accumulatedTranscript.trimEnd();
                  const shouldFlushOnSentenceEnd = this.SENTENCE_END_PATTERN.test(trimmedTranscript);
                  const shouldFlushOnComma = this.accumulatedTranscript.length >= this.FLUSH_FORCE_CHARS && this.COMMA_PATTERN.test(trimmedTranscript);
                  
                  if (shouldFlushOnSentenceEnd || shouldFlushOnComma) {
                    this.log(`🔄 Smart buffer flush at ${this.accumulatedTranscript.length} chars`, LogLevel.INFO);
                    if (callbacks.onBufferFlush) {
                      callbacks.onBufferFlush();
                    }
                    this.session?.sendRealtimeInput({ audioStreamEnd: true });
                    this.injectPostFlushContext();
                  }
                }
              }
            }

            // Model turn start
            if (message.serverContent?.modelTurn && !this.hasSignaledTurnStart) {
              this.hasSignaledTurnStart = true;
              if (callbacks.onModelTurnStart) {
                callbacks.onModelTurnStart();
              }
            }
            
            // Model content
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                  this.currentMessage += part.text;
                  if (callbacks.onPartialResponse) {
                    callbacks.onPartialResponse(part.text);
                  }
                }
              }
            }
            
            // Turn complete
            if (message.serverContent?.turnComplete) {
              this.hasSignaledTurnStart = false;

              if (this.isUserSpeaking && this.accumulatedTranscript.length > 0) {
                this.log(`✅ TURN COMPLETE - Final transcript: "${this.accumulatedTranscript.substring(0, 50)}..."`, LogLevel.SUCCESS);
                callbacks.onTranscript(this.accumulatedTranscript, true);
                this.isUserSpeaking = false;
                this.accumulatedTranscript = '';
              }

              if (this.currentMessage.trim()) {
                const completeMessage = this.currentMessage.trim();
                callbacks.onModelResponse(completeMessage);
                this.log(`Complete model response: "${completeMessage.substring(0, 50)}..."`);
              }
              this.currentMessage = '';
            }

            // Interruptions
            if (message.serverContent?.interrupted) {
              this.log("Model response interrupted.", LogLevel.INFO);
              this.hasSignaledTurnStart = false;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.log(`Session error: ${e.message}`, LogLevel.ERROR);
            callbacks.onError(e.message);
          },
          onclose: (e: CloseEvent) => {
            if (this.isIntentionallyClosing) {
              this.log("Session disconnected successfully.", LogLevel.SUCCESS);
              this.session = undefined;
            } else {
              const closeReason = e.reason || 'Connection timeout (~10 min limit)';
              this.log(`[${this.sessionHandleKey}] Session closed unexpectedly. Reason: ${closeReason}`, LogLevel.WARN);
              this.session = undefined;

              const isInvalidSession = closeReason.includes('session not found') ||
                                       closeReason.includes('BidiGenerateContent session not found') ||
                                       closeReason.includes('not found');

              if (isInvalidSession && this.currentSessionHandle) {
                this.log(`[${this.sessionHandleKey}] Session handle is invalid or expired. Clearing it.`, LogLevel.WARN);
                this.clearSessionHandle();

                if (!this.hasRetriedWithFreshSession) {
                  this.hasRetriedWithFreshSession = true;
                  this.log(`[${this.sessionHandleKey}] Retrying with fresh session...`, LogLevel.INFO);
                  this.reconnectAttempts = 0;
                  this.attemptReconnection(callbacks, systemInstruction);
                  return;
                } else {
                  this.log(`[${this.sessionHandleKey}] Fresh session retry failed. Giving up.`, LogLevel.ERROR);
                  callbacks.onClose('Invalid session handle - fresh session failed');
                  return;
                }
              }

              if (this.currentSessionHandle && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnection(callbacks, systemInstruction);
              } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                this.log(`[${this.sessionHandleKey}] Max reconnection attempts (${this.maxReconnectAttempts}) reached.`, LogLevel.ERROR);
                this.clearSessionHandle();
                callbacks.onClose(e.reason || 'Max reconnection attempts reached');
              } else {
                callbacks.onClose(e.reason || 'Unknown');
              }
            }
          },
        },
        config,
      });
      
      this.log("Session object assigned. Connection is fully ready.", LogLevel.SUCCESS);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error during connection.";
      
      if (errorMessage.includes('session not found') || errorMessage.includes('not found')) {
        this.log(`[${this.sessionHandleKey}] Session handle invalid or expired. Starting fresh session.`, LogLevel.WARN);
        this.clearSessionHandle();
        
        if (handleToUse && this.reconnectAttempts === 0) {
          this.reconnectAttempts++;
          return this.connect(callbacks, systemInstruction, null);
        }
      }
      
      this.log(`[${this.sessionHandleKey}] Connection failed: ${errorMessage}`, LogLevel.ERROR);
      callbacks.onError(errorMessage);
      throw new Error(errorMessage);
    }
  }

  private attemptReconnection(callbacks: LectureLiveApiCallbacks, systemInstruction?: string): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);
    
    this.log(`[${this.sessionHandleKey}] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`, LogLevel.INFO);
    
    if (callbacks.onReconnecting) {
      callbacks.onReconnecting();
    }
    
    this.reconnectTimeoutId = window.setTimeout(async () => {
      try {
        await this.connect(callbacks, systemInstruction, this.currentSessionHandle);
      } catch (error) {
        this.log(`[${this.sessionHandleKey}] Reconnection attempt ${this.reconnectAttempts} failed.`, LogLevel.ERROR);
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.clearSessionHandle();
          callbacks.onError('Failed to reconnect after multiple attempts');
        }
      }
    }, delay);
  }

  public async sendRealtimeAudio(audioData: string, mimeType: string = 'audio/pcm;rate=16000'): Promise<boolean> {
    if (!this.session) {
      return false;
    }

    try {
      const audioBlob: GenAIBlob = {
        mimeType: mimeType,
        data: audioData,
      };

      await this.session.sendRealtimeInput({
        audio: audioBlob,
      });

      this.log(`Sent audio chunk: ${Math.round(audioData.length * 3 / 4 / 1024)}KB`, LogLevel.SUCCESS);
      return true;
    } catch (error) {
      this.log(`[${this.sessionHandleKey}] Error sending audio: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
      return false;
    }
  }

  public async sendVideoFrame(base64Image: string): Promise<void> {
    if (!this.session) {
      this.log("Cannot send frame. Session is not connected.", LogLevel.ERROR);
      return;
    }

    try {
      const imageBlob: GenAIBlob = {
        mimeType: 'image/jpeg',
        data: base64Image,
      };

      await this.session.sendRealtimeInput({
        media: imageBlob,
      });

      this.log(`Sent video frame: ${Math.round(base64Image.length * 3 / 4 / 1024)}KB`);
    } catch (error) {
      this.log(`Error sending video frame: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  // Standard send text (triggers model response by default)
  public async sendText(text: string): Promise<void> {
    return this.sendTextWithOptions(text, { triggerResponse: true });
  }

  /**
   * Send text as realtime input (non-interrupting, like audio/video)
   * @param text - The text to send as continuous context
   */
  public async sendRealtimeText(text: string): Promise<void> {
    if (!this.session) {
      this.log("Cannot send realtime text. Session is not connected.", LogLevel.ERROR);
      return;
    }

    try {
      await this.session.sendRealtimeInput({
        text: text,
      });

      this.log(`Sent realtime text: "${text.substring(0, 50)}..."`);
    } catch (error) {
      this.log(`Error sending realtime text: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  /**
   * Send text message with options
   * @param text - The text to send
   * @param options.triggerResponse - If true, model will respond. If false, just injects context without response.
   */
  public async sendTextWithOptions(text: string, options: { triggerResponse?: boolean } = {}): Promise<void> {
    if (!this.session) {
      this.log("Cannot send text. Session is not connected.", LogLevel.ERROR);
      return;
    }

    const { triggerResponse = true } = options;

    try {
      this.session.sendClientContent({
        turns: [{
          parts: [{ text }],
        }],
        turnComplete: triggerResponse,
      });

      this.log(`Sent text (turnComplete=${triggerResponse}): "${text.substring(0, 50)}..."`);
    } catch (error) {
      this.log(`Error sending text: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  private injectPostFlushContext(): void {
    if (!this.session) {
      return;
    }

    try {
      this.session.sendClientContent({
        turns: [{
          parts: [{ text: this.LANGUAGE_HINT }],
        }],
        turnComplete: false,
      });

      this.log(`💬 Injected post-flush language hint: "${this.LANGUAGE_HINT}"`, LogLevel.INFO);
    } catch (error) {
      this.log(`Error injecting post-flush context: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.WARN);
    }
  }

  public async endAudioStream(): Promise<void> {
    if (!this.session) {
      return;
    }

    try {
      await this.session.sendRealtimeInput({
        audioStreamEnd: true,
      });
      this.log("Audio stream end signal sent.");
    } catch (error) {
      this.log(`Error ending audio stream: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  public disconnect(): void {
    if (this.reconnectTimeoutId) {
      window.clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    if (this.session) {
      this.log(`[${this.sessionHandleKey}] Disconnecting session intentionally.`, LogLevel.INFO);
      this.isIntentionallyClosing = true;
      this.currentMessage = '';
      this.session.close();
      this.session = undefined;
    }
  }
  
  public clearSession(): void {
    this.disconnect();
    this.clearSessionHandle();
    this.reconnectAttempts = 0;
    this.log(`[${this.sessionHandleKey}] Session cleared completely. Next connection will be a new session.`, LogLevel.INFO);
  }

  public isConnected(): boolean {
    return !!this.session;
  }
  
  public getSessionHandle(): string | null {
    return this.currentSessionHandle;
  }
}

export default LectureLiveApiService;
