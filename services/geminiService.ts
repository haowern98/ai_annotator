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

  constructor(apiKey: string, log: LogFunction) {
    if (!apiKey) {
      log("API key is missing.", LogLevel.ERROR);
      throw new Error("API key is missing.");
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.log = log;
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
                callbacks.onMessage(this.currentMessage.trim());
                this.log(`Complete message sent: "${this.currentMessage.substring(0, 50)}..."`);
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

    this.log(`Sending frame to AI. Image size: ${Math.round(base64Image.length * 3 / 4 / 1024)} KB. ${audioLog}${promptLog}`);
    this.session.sendClientContent({
      turns: [{ parts }],
    });
  }

  public sendVideoModeFrames(base64Images: string[], base64Audio?: string, audioMimeType?: string, prompt?: string): void {
    if (!this.session) {
      this.log("Cannot send frames. Session is not connected.", LogLevel.ERROR);
      return;
    }

    const imageParts: Part[] = base64Images.map(imageData => ({
      inlineData: {
        mimeType: 'image/jpeg',
        data: imageData,
      },
    }));
    
    const textPart: Part | null = prompt ? { text: prompt } : null;

    const audioPart: Part | null = (base64Audio && audioMimeType) ? {
        inlineData: {
            mimeType: audioMimeType,
            data: base64Audio,
        },
    } : null;

    const parts = [textPart, ...imageParts, audioPart].filter((p): p is Part => p !== null);

    const imagesSizeLog = base64Images.map((img, i) => `Image ${i + 1}: ${Math.round(img.length * 3 / 4 / 1024)} KB`).join(', ');
    const audioLog = audioPart ? ` Audio (${audioMimeType}): ${Math.round(base64Audio!.length * 3 / 4 / 1024)} KB.` : '';
    const promptLog = prompt ? ' (Includes prompt)' : '';

    this.log(`Sending ${base64Images.length} frames to AI. ${imagesSizeLog}.${audioLog}${promptLog}`);
    this.session.sendClientContent({
      turns: [{ parts }],
    });
  }

  public disconnect(): void {
    if (this.session) {
      this.log("Disconnecting session.");
      this.isIntentionallyClosing = true;
      this.currentMessage = ''; // Reset accumulator
      this.session.close();
      this.session = undefined;
    }
  }

  public isConnected(): boolean {
    return !!this.session;
  }
}

export default GeminiService;