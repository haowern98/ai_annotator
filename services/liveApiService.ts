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
  
  // Reconnection state
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectTimeoutId: number | null = null;
  private currentCallbacks: LiveApiCallbacks | null = null;
  
  // Track if we've already signaled the start of this turn
  private hasSignaledTurnStart = false;

  constructor(apiKey: string, log: LogFunction) {
    if (!apiKey) {
      log("API key is missing.", LogLevel.ERROR);
      throw new Error("API key is missing.");
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.log = log;
  }

  public async connect(callbacks: LiveApiCallbacks, systemInstruction?: string): Promise<void> {
    if (this.session) {
      this.log("Session already exists. Disconnect first.", LogLevel.WARN);
      return;
    }
    
    this.isIntentionallyClosing = false;
    this.currentCallbacks = callbacks;

    const config = {
      responseModalities: [Modality.TEXT], // Start with TEXT only to avoid audio issues
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      voiceActivityDetection: {
        threshold: 0.6, // Sensitivity (0-1, higher = more strict about detecting speech end)
      },
      contextWindowCompression: {
        triggerTokens: '25600',
        slidingWindow: { targetTokens: '12800' },
      },
      systemInstruction: systemInstruction || "You are an interview copilot AI assistant. You are observing a live screen and listening to audio. When the speaker finishes talking (turn complete), provide a full, thoughtful answer to the question. Respond to everything they say with substantive insights, answers, or observations about what you see and hear. Be helpful and thorough in every response.",
    };

    try {
      this.log("Starting new Live API session...");
      
      this.session = await this.ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            this.log("Live API connection opened successfully.", LogLevel.SUCCESS);
            this.reconnectAttempts = 0;
          },
          onmessage: (message: LiveServerMessage) => {
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
              this.log(`Session closed unexpectedly. Reason: ${e.reason || 'Connection lost'}`, LogLevel.WARN);
              this.session = undefined;
              
              // Attempt reconnection
              if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnection(callbacks, systemInstruction);
              } else {
                this.log(`Max reconnection attempts (${this.maxReconnectAttempts}) reached.`, LogLevel.ERROR);
                callbacks.onClose(e.reason || 'Max reconnection attempts reached');
              }
            }
          },
        },
        config,
      });
      
      this.log("Session object assigned. Connection is fully ready.", LogLevel.SUCCESS);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error during connection.";
      this.log(`Connection failed: ${errorMessage}`, LogLevel.ERROR);
      callbacks.onError(errorMessage);
      throw new Error(errorMessage);
    }
  }

  private attemptReconnection(callbacks: LiveApiCallbacks, systemInstruction?: string): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);
    
    this.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`, LogLevel.INFO);
    
    if (callbacks.onReconnecting) {
      callbacks.onReconnecting();
    }
    
    this.reconnectTimeoutId = window.setTimeout(async () => {
      try {
        await this.connect(callbacks, systemInstruction);
      } catch (error) {
        this.log(`Reconnection attempt ${this.reconnectAttempts} failed.`, LogLevel.ERROR);
      }
    }, delay);
  }

  // Send audio in real-time (continuous streaming)
  public async sendRealtimeAudio(audioData: string, mimeType: string = 'audio/pcm;rate=16000'): Promise<void> {
    if (!this.session) {
      this.log("Cannot send audio. Session is not connected.", LogLevel.ERROR);
      return;
    }

    try {
      const audioBlob: GenAIBlob = {
        mimeType: mimeType,
        data: audioData,
      };

      await this.session.sendRealtimeInput({
        audio: audioBlob,
      });

      this.log(`Sent audio chunk: ${Math.round(audioData.length * 3 / 4 / 1024)}KB`);
    } catch (error) {
      this.log(`Error sending audio: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
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
      this.log("Disconnecting session intentionally.", LogLevel.INFO);
      this.isIntentionallyClosing = true;
      this.currentMessage = '';
      this.session.close();
      this.session = undefined;
    }
  }

  public isConnected(): boolean {
    return !!this.session;
  }
}

export default LiveApiService;
