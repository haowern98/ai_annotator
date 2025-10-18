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

interface LiveApiCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
  onModelResponse: (text: string) => void;
  onPartialResponse?: (text: string) => void; // Real-time streaming chunks
  onModelTurnStart?: () => void; // NEW: Called when model starts responding (before any text)
  onError: (error: string) => void;
  onClose: (reason: string) => void;
  onReconnecting?: () => void;
}

// Correct model for Live API
const MODEL_NAME = 'gemini-2.5-flash-live-preview';

class LiveApiService {
  private session: Session | undefined = undefined;
  private ai: GoogleGenAI;
  private log: LogFunction;
  private isIntentionallyClosing = false;
  private currentMessage = '';
  
  // Session resumption state
  private sessionHandleKey: string; // Unique localStorage key for this service instance
  private currentSessionHandle: string | null = null;
  
  // Reconnection state
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectTimeoutId: number | null = null;
  private currentCallbacks: LiveApiCallbacks | null = null;
  private currentSystemInstruction: string | undefined = undefined;
  private hasRetriedWithFreshSession = false; // Track if we've already tried a fresh session
  
  // Track if we've already signaled the start of this turn
  private hasSignaledTurnStart = false;

  constructor(apiKey: string, log: LogFunction, sessionKey: string = 'default') {
    if (!apiKey) {
      log("API key is missing.", LogLevel.ERROR);
      throw new Error("API key is missing.");
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.log = log;
    
    // Create unique session handle key for this service instance (transcript vs reply)
    this.sessionHandleKey = `gemini_live_session_${sessionKey}`;
    
    // Try to load existing session handle from localStorage
    this.loadSessionHandle();
  }
  
  // Load session handle from localStorage
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
  
  // Save session handle to localStorage
  private saveSessionHandle(handle: string): void {
    try {
      localStorage.setItem(this.sessionHandleKey, handle);
      this.currentSessionHandle = handle;
      this.log(`[${this.sessionHandleKey}] Saved session handle: ${handle.substring(0, 8)}...`, LogLevel.SUCCESS);
    } catch (error) {
      this.log(`[${this.sessionHandleKey}] Could not save session handle to localStorage`, LogLevel.WARN);
    }
  }
  
  // Clear session handle
  private clearSessionHandle(): void {
    try {
      localStorage.removeItem(this.sessionHandleKey);
      this.currentSessionHandle = null;
      this.log(`[${this.sessionHandleKey}] Cleared session handle`, LogLevel.INFO);
    } catch (error) {
      this.log(`[${this.sessionHandleKey}] Could not clear session handle from localStorage`, LogLevel.WARN);
    }
  }

  public async connect(callbacks: LiveApiCallbacks, systemInstruction?: string, resumeHandle?: string | null): Promise<void> {
    if (this.session) {
      this.log("Session already exists. Disconnect first.", LogLevel.WARN);
      return;
    }

    this.isIntentionallyClosing = false;
    this.currentCallbacks = callbacks;
    this.currentSystemInstruction = systemInstruction;
    this.hasRetriedWithFreshSession = false; // Reset fresh session flag on new connection
    
    // Use provided handle, or fall back to saved handle, or null for new session
    const handleToUse = resumeHandle !== undefined ? resumeHandle : this.currentSessionHandle;

    const config = {
      responseModalities: [Modality.TEXT], // Start with TEXT only to avoid audio issues
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      voiceActivityDetection: {
        threshold: 0.5, // Sensitivity (0-1, higher = more strict about detecting speech end)
      },
      contextWindowCompression: {
        triggerTokens: '25600',
        slidingWindow: { targetTokens: '12800' },
      },
      sessionResumption: handleToUse ? { handle: handleToUse } : {},
      systemInstruction: systemInstruction || "You are an interview copilot AI assistant. You are observing a live screen and listening to audio. When the speaker finishes talking (turn complete), provide a full, thoughtful answer to the question. Respond to everything they say with substantive insights, answers, or observations about what you see and hear. Be helpful and thorough in every response.",
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
            
            // Handle GoAway message (connection about to close)
            if (message.goAway) {
              const timeLeft = message.goAway.timeLeft || 'unknown';
              this.log(`[${this.sessionHandleKey}] ⚠️ Connection will close in ${timeLeft}. Preparing to reconnect...`, LogLevel.WARN);
              // The connection will close soon, we'll handle reconnection in onclose
            }
            
            // DEBUG: Log full message structure to understand what we're receiving
            if (message.serverContent) {
              this.log(`Message type: ${JSON.stringify(Object.keys(message.serverContent))}`);
            }
            
            // CRITICAL: Detect when model starts responding (BEFORE any text arrives)
            if (message.serverContent?.modelTurn && !this.hasSignaledTurnStart) {
              this.hasSignaledTurnStart = true;
              if (callbacks.onModelTurnStart) {
                callbacks.onModelTurnStart();
                this.log("Model turn started - buffering should begin now", LogLevel.INFO);
              }
            }
            
            // Handle model content (streaming AI responses)
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                  this.currentMessage += part.text;
                  this.log(`Received text chunk: "${part.text.substring(0, 50)}..."`);
                  // Send partial response for live streaming in UI
                  if (callbacks.onPartialResponse) {
                    callbacks.onPartialResponse(part.text);
                  }
                }
              }
            }
            
            // Handle user transcription (speech-to-text from interviewer)
            // Check multiple possible locations for transcript data
            const serverContent = message.serverContent as any; // Type assertion to access potential transcript properties
            if (serverContent?.userTranscription) {
              const transcript = serverContent.userTranscription;
              if (transcript.text) {
                const isFinal = transcript.isFinal || false;
                this.log(`User transcript (${isFinal ? 'final' : 'partial'}): "${transcript.text.substring(0, 50)}..."`);
                callbacks.onTranscript(transcript.text, isFinal);
              }
            }
            
            // Alternative: Check if transcript is in turnComplete
            if (serverContent?.turnComplete && serverContent.transcript) {
              const transcriptText = serverContent.transcript;
              this.log(`Turn complete with transcript: "${transcriptText.substring(0, 50)}..."`);
              callbacks.onTranscript(transcriptText, true);
            }
            
            // Handle turn complete
            if (message.serverContent?.turnComplete) {
              // Reset the turn start flag for next turn
              this.hasSignaledTurnStart = false;
              
              if (this.currentMessage.trim()) {
                const completeMessage = this.currentMessage.trim();
                callbacks.onModelResponse(completeMessage);
                this.log(`Complete model response: "${completeMessage.substring(0, 50)}..."`);
              }
              this.currentMessage = '';
            }

            // Handle interruptions
            if (message.serverContent?.interrupted) {
              this.log("Model response interrupted.", LogLevel.INFO);
              // Reset turn start flag on interruption
              this.hasSignaledTurnStart = false;
              // Keep currentMessage accumulated - don't clear it
            }

            // Handle user transcription (if supported in future)
            if (message.toolCall) {
              this.log(`Tool call received: ${JSON.stringify(message.toolCall).substring(0, 100)}...`);
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

              // Check if close reason indicates invalid/expired session handle
              const isInvalidSession = closeReason.includes('session not found') ||
                                       closeReason.includes('BidiGenerateContent session not found') ||
                                       closeReason.includes('not found');

              if (isInvalidSession && this.currentSessionHandle) {
                this.log(`[${this.sessionHandleKey}] Session handle is invalid or expired. Clearing it.`, LogLevel.WARN);
                this.clearSessionHandle();

                // Try ONE more time with a fresh session (no handle)
                if (!this.hasRetriedWithFreshSession) {
                  this.hasRetriedWithFreshSession = true;
                  this.log(`[${this.sessionHandleKey}] Retrying with fresh session...`, LogLevel.INFO);
                  this.reconnectAttempts = 0; // Reset attempts for fresh session
                  this.attemptReconnection(callbacks, systemInstruction);
                  return;
                } else {
                  this.log(`[${this.sessionHandleKey}] Fresh session retry failed. Giving up.`, LogLevel.ERROR);
                  callbacks.onClose('Invalid session handle - fresh session failed');
                  return;
                }
              }

              // Normal reconnection logic for valid handles
              if (this.currentSessionHandle && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnection(callbacks, systemInstruction);
              } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                this.log(`[${this.sessionHandleKey}] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`, LogLevel.ERROR);
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
      
      // Check if this is a "session not found" error (handle expired or invalid)
      if (errorMessage.includes('session not found') || errorMessage.includes('not found')) {
        this.log(`[${this.sessionHandleKey}] Session handle invalid or expired. Starting fresh session.`, LogLevel.WARN);
        this.clearSessionHandle();
        
        // Retry connection without handle (new session)
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

  // Attempt to reconnect with saved session handle
  private attemptReconnection(callbacks: LiveApiCallbacks, systemInstruction?: string): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000); // Exponential backoff, max 5s
    
    this.log(`[${this.sessionHandleKey}] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`, LogLevel.INFO);
    
    if (callbacks.onReconnecting) {
      callbacks.onReconnecting();
    }
    
    this.reconnectTimeoutId = window.setTimeout(async () => {
      try {
        await this.connect(callbacks, systemInstruction, this.currentSessionHandle);
      } catch (error) {
        this.log(`[${this.sessionHandleKey}] Reconnection attempt ${this.reconnectAttempts} failed.`, LogLevel.ERROR);
        
        // If we still have attempts left, the onclose handler will retry
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.clearSessionHandle();
          callbacks.onError('Failed to reconnect after multiple attempts');
        }
      }
    }, delay);
  }

  // Send audio in real-time (continuous streaming)
  public async sendRealtimeAudio(audioData: string, mimeType: string = 'audio/pcm;rate=16000'): Promise<boolean> {
    if (!this.session) {
      // Silently fail - this is expected during reconnection
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

  // Send video frame
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

  // Send text message
  public async sendText(text: string): Promise<void> {
    if (!this.session) {
      this.log("Cannot send text. Session is not connected.", LogLevel.ERROR);
      return;
    }

    try {
      this.session.sendClientContent({
        turns: [{
          parts: [{ text }],
        }],
      });

      this.log(`Sent text message: "${text.substring(0, 50)}..."`);
    } catch (error) {
      this.log(`Error sending text: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
    }
  }

  // Signal end of audio stream (e.g., when mic is paused)
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
    
    // Don't clear session handle on intentional disconnect
    // This allows resuming the session later if needed
  }
  
  // Force clear session and start fresh
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

export default LiveApiService;
