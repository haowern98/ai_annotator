import {
  GoogleGenAI,
  LiveServerMessage,
  MediaResolution,
  Modality,
  Session,
  Part,
} from '@google/genai';
import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

interface GeminiServiceCallbacks {
  onMessage: (message: string) => void;
  onError: (error: string) => void;
  onClose: (reason: string) => void;
  onReconnecting?: () => void; // Optional callback for reconnection events
}

// Reverted to the specific live model required by the ai.live.connect API.
const MODEL_NAME = 'models/gemini-2.5-flash-live-preview';

// Local storage key for session handle
const SESSION_HANDLE_KEY = 'gemini_session_handle';

class GeminiService {
  private session: Session | undefined = undefined;
  private ai: GoogleGenAI;
  private log: LogFunction;
  private isIntentionallyClosing = false;
  private currentMessage = '';
  
  // Session resumption state
  private currentSessionHandle: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectTimeoutId: number | null = null;
  private currentCallbacks: GeminiServiceCallbacks | null = null;
  
  // Summary completion tracking
  private summaryCompletionCallback: (() => void) | null = null;
  private isExpectingSummary = false;
  private summaryTimeoutId: number | null = null;
  private readonly SUMMARY_TIMEOUT_MS = 30000; // 30 seconds

  constructor(apiKey: string, log: LogFunction) {
    if (!apiKey) {
      log("API key is missing.", LogLevel.ERROR);
      throw new Error("API key is missing.");
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.log = log;
    
    // Try to load existing session handle from localStorage
    this.loadSessionHandle();
  }

  // Load session handle from localStorage
  private loadSessionHandle(): void {
    try {
      const savedHandle = localStorage.getItem(SESSION_HANDLE_KEY);
      if (savedHandle) {
        this.currentSessionHandle = savedHandle;
        this.log(`Loaded existing session handle: ${savedHandle.substring(0, 8)}...`, LogLevel.INFO);
      }
    } catch (error) {
      this.log("Could not load session handle from localStorage", LogLevel.WARN);
    }
  }

  // Save session handle to localStorage
  private saveSessionHandle(handle: string): void {
    try {
      localStorage.setItem(SESSION_HANDLE_KEY, handle);
      this.currentSessionHandle = handle;
      this.log(`Saved session handle: ${handle.substring(0, 8)}...`, LogLevel.SUCCESS);
    } catch (error) {
      this.log("Could not save session handle to localStorage", LogLevel.WARN);
    }
  }

  // Clear session handle
  private clearSessionHandle(): void {
    try {
      localStorage.removeItem(SESSION_HANDLE_KEY);
      this.currentSessionHandle = null;
      this.log("Cleared session handle", LogLevel.INFO);
    } catch (error) {
      this.log("Could not clear session handle from localStorage", LogLevel.WARN);
    }
  }

  // Set callback for when summary is complete
  public onSummaryComplete(callback: () => void): void {
    this.summaryCompletionCallback = callback;
  }

  public async connect(callbacks: GeminiServiceCallbacks, resumeHandle?: string | null): Promise<void> {
    if (this.session) {
      this.log("Session already exists. Disconnect first.", LogLevel.WARN);
      return;
    }
    
    this.isIntentionallyClosing = false;
    this.currentCallbacks = callbacks;

    // Use provided handle, or fall back to saved handle, or null for new session
    const handleToUse = resumeHandle !== undefined ? resumeHandle : this.currentSessionHandle;

    const config = {
      responseModalities: [Modality.TEXT],
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      contextWindowCompression: {
        triggerTokens: '25600',
        slidingWindow: { targetTokens: '12800' },
      },
      sessionResumption: handleToUse ? { handle: handleToUse } : {},
    };

    try {
      if (handleToUse) {
        this.log(`Attempting to resume session with handle: ${handleToUse.substring(0, 8)}...`);
      } else {
        this.log("Starting new session...");
      }
      
      this.session = await this.ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            if (handleToUse) {
              this.log("Connection resumed successfully with previous context.", LogLevel.SUCCESS);
              
              // If we were expecting a summary before disconnect, re-request it
              if (this.isExpectingSummary) {
                this.log("Summary was interrupted by disconnect. Re-requesting summary...", LogLevel.WARN);
                
                // CRITICAL: Clear any partial buffered response to prevent duplicates
                this.currentMessage = '';
                this.log("Cleared partial summary buffer to prevent duplicates.", LogLevel.INFO);
                
                // Small delay to ensure connection is stable
                setTimeout(() => {
                  this.requestSummary();
                }, 1000);
              }
            } else {
              this.log("New connection opened successfully.", LogLevel.SUCCESS);
            }
            this.reconnectAttempts = 0; // Reset reconnect counter on successful connection
          },
          onmessage: (message: LiveServerMessage) => {
            // Handle session resumption updates
            if (message.sessionResumptionUpdate) {
              const update = message.sessionResumptionUpdate;
              if (update.resumable && update.newHandle) {
                this.saveSessionHandle(update.newHandle);
                this.log(`Session handle updated: ${update.newHandle.substring(0, 8)}...`, LogLevel.INFO);
              }
            }

            // Handle GoAway message (connection about to close)
            if (message.goAway) {
              const timeLeft = message.goAway.timeLeft || 'unknown';
              this.log(`⚠️ Connection will close in ${timeLeft}. Preparing to reconnect...`, LogLevel.WARN);
              // The connection will close soon, we'll handle reconnection in onclose
            }

            // Handle model content
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.text) {
                  this.currentMessage += part.text;
                  this.log(`Received chunk: "${part.text.substring(0, 50)}..."`);
                }
              }
            }
            
            // Check if this is the end of the turn (message complete)
            if (message.serverContent?.turnComplete) {
              if (this.currentMessage.trim()) {
                const completeMessage = this.currentMessage.trim();
                callbacks.onMessage(completeMessage);
                this.log(`Complete message sent: "${completeMessage.substring(0, 50)}..."`);
                
                // Check if this was a summary response
                this.checkForSummaryCompletion(completeMessage);
              }
              this.currentMessage = ''; // Reset for next message
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
              this.log(`Session closed unexpectedly. Reason: ${e.reason || 'Connection timeout (~10 min limit)'}`, LogLevel.WARN);
              this.session = undefined;
              
              // Attempt automatic reconnection if we have a session handle
              if (this.currentSessionHandle && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnection(callbacks);
              } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                this.log(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`, LogLevel.ERROR);
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
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during connection.";
      
      // Check if this is a "session not found" error (handle expired or invalid)
      if (errorMessage.includes('session not found') || errorMessage.includes('not found')) {
        this.log(`Session handle invalid or expired. Starting fresh session.`, LogLevel.WARN);
        this.clearSessionHandle();
        
        // Retry connection without handle (new session)
        if (handleToUse && this.reconnectAttempts === 0) {
          this.reconnectAttempts++;
          return this.connect(callbacks, null);
        }
      }
      
      this.log(`Connection failed: ${errorMessage}`, LogLevel.ERROR);
      callbacks.onError(errorMessage);
      throw new Error(errorMessage);
    }
  }

  // Attempt to reconnect with saved session handle
  private attemptReconnection(callbacks: GeminiServiceCallbacks): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000); // Exponential backoff, max 5s
    
    this.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`, LogLevel.INFO);
    
    if (callbacks.onReconnecting) {
      callbacks.onReconnecting();
    }
    
    this.reconnectTimeoutId = window.setTimeout(async () => {
      try {
        await this.connect(callbacks, this.currentSessionHandle);
      } catch (error) {
        this.log(`Reconnection attempt ${this.reconnectAttempts} failed.`, LogLevel.ERROR);
        
        // If we still have attempts left, the onclose handler will retry
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.clearSessionHandle();
          callbacks.onError('Failed to reconnect after multiple attempts');
        }
      }
    }, delay);
  }

  // Check if the received message indicates a completed summary
  private checkForSummaryCompletion(message: string): void {
    if (!this.isExpectingSummary || !this.summaryCompletionCallback) {
      return;
    }

    // Detect summary completion based on message patterns for 5-second sampling
    const summaryIndicators = [
      'Individual 5-second summaries',
      'Data Point 1 (0-5 seconds)',
      'Data Point 12 (55-60 seconds)',
      'comprehensive analysis',
      'full comprehensive analysis',
      'Visual Evolution (0-60 seconds)',
      'Audio Summary (Complete Minute)',
      'Teaching Flow:',
      'Key Takeaways:',
      // Add more patterns as needed based on your prompt structure
    ];

    const hasSummaryContent = summaryIndicators.some(indicator => 
      message.toLowerCase().includes(indicator.toLowerCase())
    );

    // Also check for substantial length (summaries should be longer than simple "Received Data X" responses)
    // For 12 data points, summaries should be significantly longer
    const isSubstantialResponse = message.length > 150;

    // Additional check for 12-point summary structure
    const hasMultipleDataPoints = (message.match(/Data Point \d+/g) || []).length >= 5;

    if (hasSummaryContent && isSubstantialResponse && hasMultipleDataPoints) {
      this.log("Summary response detected for 12-point cycle. Notifying VideoModeCapture.", LogLevel.SUCCESS);
      this.isExpectingSummary = false;
      
      // Clear timeout since we received the summary
      if (this.summaryTimeoutId) {
        window.clearTimeout(this.summaryTimeoutId);
        this.summaryTimeoutId = null;
      }
      
      this.summaryCompletionCallback();
    }
  }

  public sendFrame(base64Image: string, base64Audio?: string, audioMimeType?: string, prompt?: string): void {
    if (!this.session) {
      this.log("Cannot send frame. Session is not connected.", LogLevel.ERROR);
      return;
    }

    const imagePart: Part = {
      inlineData: {
        mimeType: 'image/jpeg',
        data: base64Image,
      },
    };
    
    const textPart: Part | null = prompt ? { text: prompt } : null;

    const audioPart: Part | null = (base64Audio && audioMimeType) ? {
        inlineData: {
            mimeType: audioMimeType,
            data: base64Audio,
        },
    } : null;

    const parts = [textPart, imagePart, audioPart].filter((p): p is Part => p !== null);

    const audioLog = audioPart ? `Audio (${audioMimeType}) size: ${Math.round(base64Audio!.length * 3 / 4 / 1024)} KB. ` : '';
    const promptLog = prompt ? '(Includes initial prompt)' : '';

    // Check if this is a summary request (now data set 12 instead of 6)
    if (prompt && prompt.includes('This is data set 12')) {
      this.log("Data set 12 detected - expecting summary response.", LogLevel.INFO);
      this.isExpectingSummary = true;
    }

    this.log(`Sending frame to AI. Image size: ${Math.round(base64Image.length * 3 / 4 / 1024)} KB. ${audioLog}${promptLog}`);
    this.session.sendClientContent({
      turns: [{ parts }],
    });
  }

  public requestSummary(): void {
    if (!this.session) {
      this.log("Cannot request summary. Session is not connected.", LogLevel.ERROR);
      return;
    }

    const summaryRequestText = "Please provide a comprehensive summary of all the visual and audio content you've analyzed over the past minute. Follow the format specified in the initial prompt.";
    
    this.log("Requesting summary from AI based on accumulated data.");
    this.isExpectingSummary = true; // Set expectation flag
    
    // Set timeout in case summary never arrives
    if (this.summaryTimeoutId) {
      window.clearTimeout(this.summaryTimeoutId);
    }
    
    this.summaryTimeoutId = window.setTimeout(() => {
      if (this.isExpectingSummary) {
        this.log("Summary timeout reached. Resetting cycle and continuing.", LogLevel.WARN);
        this.isExpectingSummary = false;
        this.summaryTimeoutId = null;
        
        // Notify callback to reset and continue
        if (this.summaryCompletionCallback) {
          this.summaryCompletionCallback();
        }
      }
    }, this.SUMMARY_TIMEOUT_MS);
    
    this.session.sendClientContent({
      turns: [{ parts: [{ text: summaryRequestText }] }],
    });
  }

  public disconnect(): void {
    if (this.reconnectTimeoutId) {
      window.clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    
    if (this.summaryTimeoutId) {
      window.clearTimeout(this.summaryTimeoutId);
      this.summaryTimeoutId = null;
    }
    
    if (this.session) {
      this.log("Disconnecting session intentionally.", LogLevel.INFO);
      this.isIntentionallyClosing = true;
      this.currentMessage = ''; // Reset accumulator
      this.isExpectingSummary = false; // Reset summary expectation
      this.session.close();
      this.session = undefined;
    }
    
    // Don't clear session handle on intentional disconnect
    // This allows resuming the session later if needed
  }

  // Force clear session and start fresh
  public clearSession(): void {
    if (this.summaryTimeoutId) {
      window.clearTimeout(this.summaryTimeoutId);
      this.summaryTimeoutId = null;
    }
    
    this.disconnect();
    this.clearSessionHandle();
    this.reconnectAttempts = 0;
    this.log("Session cleared completely. Next connection will be a new session.", LogLevel.INFO);
  }

  public isConnected(): boolean {
    return !!this.session;
  }

  public getSessionHandle(): string | null {
    return this.currentSessionHandle;
  }
}

export default GeminiService;
