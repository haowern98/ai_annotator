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
}

// Reverted to the specific live model required by the ai.live.connect API.
const MODEL_NAME = 'models/gemini-2.5-flash-live-preview';

class GeminiService {
  private session: Session | undefined = undefined;
  private ai: GoogleGenAI;
  private log: LogFunction;
  private isIntentionallyClosing = false;
  private currentMessage = '';
  
  // Summary completion tracking
  private summaryCompletionCallback: (() => void) | null = null;
  private isExpectingSummary = false;

  constructor(apiKey: string, log: LogFunction) {
    if (!apiKey) {
      log("API key is missing.", LogLevel.ERROR);
      throw new Error("API key is missing.");
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.log = log;
  }

  // Set callback for when summary is complete
  public onSummaryComplete(callback: () => void): void {
    this.summaryCompletionCallback = callback;
  }

  public async connect(callbacks: GeminiServiceCallbacks): Promise<void> {
    if (this.session) {
      this.log("Session already exists. Disconnect first.", LogLevel.WARN);
      return;
    }
    
    this.isIntentionallyClosing = false;

    const config = {
      responseModalities: [Modality.TEXT],
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      contextWindowCompression: {
         triggerTokens: '25600',
          slidingWindow: { targetTokens: '12800' },
      }
    };

    try {
      this.log("Attempting to connect to Gemini service...");
      this.session = await this.ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            this.log("Connection opened successfully.", LogLevel.SUCCESS);
          },
          onmessage: (message: LiveServerMessage) => {
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
            callbacks.onError(e.message)
          },
          onclose: (e: CloseEvent) => {
            if (this.isIntentionallyClosing) {
                this.log("Session disconnected successfully.", LogLevel.SUCCESS);
            } else {
                this.log(`Session closed unexpectedly. Reason: ${e.reason || 'Unknown'}`, LogLevel.WARN);
            }
            callbacks.onClose(e.reason)
          },
        },
        config,
      });
      this.log("Session object assigned. Connection is fully ready.", LogLevel.SUCCESS);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during connection.";
      this.log(`Connection failed: ${errorMessage}`, LogLevel.ERROR);
      callbacks.onError(errorMessage);
      throw new Error(errorMessage);
    }
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
    this.session.sendClientContent({
      turns: [{ parts: [{ text: summaryRequestText }] }],
    });
  }

  public disconnect(): void {
    if (this.session) {
      this.log("Disconnecting session.");
      this.isIntentionallyClosing = true;
      this.currentMessage = ''; // Reset accumulator
      this.isExpectingSummary = false; // Reset summary expectation
      this.session.close();
      this.session = undefined;
    }
  }

  public isConnected(): boolean {
    return !!this.session;
  }
}

export default GeminiService;