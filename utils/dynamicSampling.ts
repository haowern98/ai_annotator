import React from 'react';
import { AppStatus, LogLevel } from '../types';
import GeminiService from '../services/geminiService';

type LogFunction = (message: string, level?: LogLevel) => void;

interface DynamicSamplingConfig {
  minIntervalMs: number;
  maxIntervalMs: number;
  highChangeIntervalMs: number;
  mediumChangeIntervalMs: number;
  lowChangeIntervalMs: number;
  changeThreshold: number;
  analysisWindowMs: number;
  dynamicSamplingPrompt: string;
}

interface DynamicSamplingCallbacks {
  onSummary: (summary: string) => void;
  onError: (error: string) => void;
  onStatusChange: (status: AppStatus) => void;
}

enum ChangeLevel {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  NONE = 'NONE'
}

export class DynamicSampling {
  private config: DynamicSamplingConfig;
  private callbacks: DynamicSamplingCallbacks;
  private log: LogFunction;
  private geminiService: GeminiService | null = null;
  
  private videoRef: React.RefObject<HTMLVideoElement>;
  private canvasRef: React.RefObject<HTMLCanvasElement>;
  private mediaRecorderRef: React.RefObject<MediaRecorder | null>;
  private audioMimeTypeRef: React.RefObject<string>;
  private statusRef: React.RefObject<AppStatus>;
  
  private captureTimeoutId: number | null = null;
  private summaryIntervalId: number | null = null;
  private captureCount = 0;
  private sessionStartTime = 0;
  private lastFrameData: ImageData | null = null;

  // Promise queue to prevent race conditions
  private operationQueue: Promise<void> = Promise.resolve();
  private isProcessingReset = false;
  private nextCaptureId = 1; // Atomic counter for next capture

  constructor(
    config: DynamicSamplingConfig,
    callbacks: DynamicSamplingCallbacks,
    log: LogFunction,
    refs: {
      videoRef: React.RefObject<HTMLVideoElement>;
      canvasRef: React.RefObject<HTMLCanvasElement>;
      mediaRecorderRef: React.RefObject<MediaRecorder | null>;
      audioMimeTypeRef: React.RefObject<string>;
      statusRef: React.RefObject<AppStatus>;
    }
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.log = log;
    this.videoRef = refs.videoRef;
    this.canvasRef = refs.canvasRef;
    this.mediaRecorderRef = refs.mediaRecorderRef;
    this.audioMimeTypeRef = refs.audioMimeTypeRef;
    this.statusRef = refs.statusRef;
  }

  public setGeminiService(service: GeminiService): void {
    this.geminiService = service;
  }

  public start(): void {
    if (!this.geminiService?.isConnected()) {
      this.log("Cannot start dynamic sampling: Gemini service not connected.", LogLevel.ERROR);
      return;
    }

    this.log("Starting dynamic sampling with content-based adaptive intervals", LogLevel.SUCCESS);
    
    // Reset all state atomically
    this.captureCount = 0;
    this.nextCaptureId = 1;
    this.isProcessingReset = false;
    this.operationQueue = Promise.resolve();
    this.sessionStartTime = Date.now();
    this.lastFrameData = null;

    // Start summary interval (every 60 seconds)
    this.summaryIntervalId = window.setInterval(() => {
      this.queueSummaryRequest();
    }, this.config.analysisWindowMs);

    // Capture first frame immediately
    this.scheduleNextCapture(0);
  }

  public stop(): void {
    this.log("Stopping dynamic sampling.", LogLevel.INFO);
    
    // Set reset flag to prevent new operations
    this.isProcessingReset = true;
    
    if (this.captureTimeoutId) {
      window.clearTimeout(this.captureTimeoutId);
      this.captureTimeoutId = null;
    }
    
    if (this.summaryIntervalId) {
      window.clearInterval(this.summaryIntervalId);
      this.summaryIntervalId = null;
    }
    
    // Reset state atomically
    this.captureCount = 0;
    this.nextCaptureId = 1;
    this.sessionStartTime = 0;
    this.lastFrameData = null;
    this.operationQueue = Promise.resolve();
    this.isProcessingReset = false;
  }

  private scheduleNextCapture(delay: number): void {
    this.captureTimeoutId = window.setTimeout(() => {
      this.queueCaptureOperation();
    }, delay);
  }

  // Queue capture operations to prevent race conditions
  private queueCaptureOperation(): void {
    this.operationQueue = this.operationQueue.then(async () => {
      // Check if we're in the middle of a reset cycle
      if (this.isProcessingReset) {
        this.log("Skipping capture: reset in progress", LogLevel.INFO);
        return;
      }
      
      try {
        await this.captureAndAnalyze();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Error in capture operation: ${message}`, LogLevel.ERROR);
      }
    });
  }

  // Queue summary requests to prevent race conditions with captures
  private queueSummaryRequest(): void {
    this.operationQueue = this.operationQueue.then(async () => {
      try {
        await this.requestSummary();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Error in summary request: ${message}`, LogLevel.ERROR);
      }
    });
  }

  private async captureAndAnalyze(): Promise<void> {
    if (!this.videoRef.current || !this.canvasRef.current || !this.geminiService?.isConnected()) {
      this.log("Skipping capture: core dependencies not ready.", LogLevel.WARN);
      this.scheduleNextCapture(this.config.mediumChangeIntervalMs);
      return;
    }

    const currentStream = this.videoRef.current.srcObject as MediaStream | null;
    if (!currentStream || !currentStream.active) {
      this.log("Media stream is not active. Stopping dynamic sampling.", LogLevel.WARN);
      this.callbacks.onError("Media stream became inactive");
      return;
    }

    const video = this.videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      this.log("Video has no dimensions yet, skipping capture.", LogLevel.WARN);
      this.scheduleNextCapture(this.config.mediumChangeIntervalMs);
      return;
    }

    // Assign capture ID atomically and increment counter
    const currentCaptureId = this.nextCaptureId;
    this.nextCaptureId++;
    this.captureCount = currentCaptureId; // Keep captureCount in sync for logging
    
    this.log(`Starting capture ${currentCaptureId} (atomic assignment)`, LogLevel.INFO);

    // 1. Capture current frame
    const canvas = this.canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.log(`Failed to get 2D context from canvas for capture ${currentCaptureId}.`, LogLevel.ERROR);
      this.scheduleNextCapture(this.config.mediumChangeIntervalMs);
      return;
    }
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const currentFrameData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const videoBase64Data = dataUrl.split(',')[1];

    // 2. Detect change level
    const changeLevel = this.detectChangeLevel(currentFrameData);
    this.lastFrameData = currentFrameData;

    // 3. Log capture info
    const elapsedTime = Math.round((Date.now() - this.sessionStartTime) / 1000);
    this.log(`Capture ${currentCaptureId} at ${elapsedTime}s - Change level: ${changeLevel}`);

    // 4. Generate prompt for this capture
    const prompt = this.generatePromptForCapture(currentCaptureId, changeLevel, elapsedTime);

    // 5. Handle audio capture
    const recorder = this.mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      this.log(`Audio recorder not ready for capture ${currentCaptureId}. Sending frame without audio.`, LogLevel.WARN);
      this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);
      this.scheduleNextCaptureBasedOnChange(changeLevel);
      return;
    }

    try {
      const { audioData, mimeType } = await this.captureAudioSnippet(recorder);
      
      // Check if we're still in valid state after async operation
      if (this.isProcessingReset) {
        this.log(`Capture ${currentCaptureId} completed but reset in progress, discarding`, LogLevel.INFO);
        return;
      }
      
      // Send data to Gemini
      this.geminiService.sendFrame(videoBase64Data, audioData, mimeType, prompt);
      
      this.log(`Capture ${currentCaptureId} sent successfully (${Math.round(videoBase64Data.length * 3 / 4 / 1024)}KB image, ${Math.round(audioData.length * 3 / 4 / 1024)}KB audio, ${changeLevel} change)`);
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Error capturing audio for capture ${currentCaptureId}: ${message}. Sending video only.`, LogLevel.WARN);
      
      // Check if we're still in valid state after error
      if (!this.isProcessingReset) {
        this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);

        // Restart recording on failure
        if (this.mediaRecorderRef.current?.state === 'inactive' && this.statusRef.current === AppStatus.ANALYZING) {
          this.mediaRecorderRef.current.start();
        }
      } else {
        this.log(`Capture ${currentCaptureId} error occurred during reset, discarding`, LogLevel.INFO);
      }
    }

    // 6. Schedule next capture based on detected change (only if not resetting)
    if (!this.isProcessingReset) {
      this.scheduleNextCaptureBasedOnChange(changeLevel);
    }
  }

  private detectChangeLevel(currentFrame: ImageData): ChangeLevel {
    if (!this.lastFrameData) {
      return ChangeLevel.MEDIUM; // First frame, assume medium change
    }

    if (currentFrame.data.length !== this.lastFrameData.data.length) {
      return ChangeLevel.HIGH; // Resolution changed
    }

    // Calculate pixel difference percentage
    const pixelCount = currentFrame.data.length / 4; // RGBA = 4 values per pixel
    let changedPixels = 0;
    const threshold = 30; // RGB difference threshold per pixel

    for (let i = 0; i < currentFrame.data.length; i += 4) {
      const rDiff = Math.abs(currentFrame.data[i] - this.lastFrameData.data[i]);
      const gDiff = Math.abs(currentFrame.data[i + 1] - this.lastFrameData.data[i + 1]);
      const bDiff = Math.abs(currentFrame.data[i + 2] - this.lastFrameData.data[i + 2]);
      
      if (rDiff > threshold || gDiff > threshold || bDiff > threshold) {
        changedPixels++;
      }
    }

    const changePercentage = changedPixels / pixelCount;

    if (changePercentage > this.config.changeThreshold * 2) {
      return ChangeLevel.HIGH;
    } else if (changePercentage > this.config.changeThreshold) {
      return ChangeLevel.MEDIUM;
    } else if (changePercentage > this.config.changeThreshold * 0.1) {
      return ChangeLevel.LOW;
    } else {
      return ChangeLevel.NONE;
    }
  }

  private scheduleNextCaptureBasedOnChange(changeLevel: ChangeLevel): void {
    let nextInterval: number;

    switch (changeLevel) {
      case ChangeLevel.HIGH:
        nextInterval = this.config.highChangeIntervalMs;
        break;
      case ChangeLevel.MEDIUM:
        nextInterval = this.config.mediumChangeIntervalMs;
        break;
      case ChangeLevel.LOW:
        nextInterval = this.config.lowChangeIntervalMs;
        break;
      case ChangeLevel.NONE:
        nextInterval = this.config.maxIntervalMs;
        break;
      default:
        nextInterval = this.config.mediumChangeIntervalMs;
    }

    // Ensure interval is within bounds
    nextInterval = Math.max(this.config.minIntervalMs, Math.min(nextInterval, this.config.maxIntervalMs));

    this.log(`Next capture scheduled in ${nextInterval / 1000}s based on ${changeLevel} change level`);
    this.scheduleNextCapture(nextInterval);
  }

  private generatePromptForCapture(captureNumber: number, changeLevel: ChangeLevel, elapsedSeconds: number): string {
    if (captureNumber === 1) {
      // First capture: Set context and instructions
      return `DYNAMIC SAMPLING MODE - You are analyzing a lecture/presentation through adaptive content sampling.

You will receive dynamic sampling captures triggered by visual change detection. Each capture includes a screenshot and audio segment.

${this.config.dynamicSamplingPrompt}

For data captures: Store the content in memory and acknowledge with "Received Dynamic Capture [number] ([change_level] change at [time]s)".

When you receive a "SUMMARY REQUEST", provide comprehensive educational analysis instead of acknowledgments.

This is Dynamic Sampling Capture #${captureNumber} at ${elapsedSeconds}s (Change Level: ${changeLevel})

Respond: "Received Dynamic Capture ${captureNumber} (${changeLevel} change at ${elapsedSeconds}s)".`;
    } else {
      // Subsequent captures: Minimal prompt to reduce token usage
      return `Dynamic Sampling Capture #${captureNumber} at ${elapsedSeconds}s (${changeLevel} change). Store in memory. Respond: "Received Dynamic Capture ${captureNumber} (${changeLevel} change at ${elapsedSeconds}s)".`;
    }
  }

  private async captureAudioSnippet(recorder: MediaRecorder): Promise<{ audioData: string; mimeType: string }> {
    return new Promise<{ audioData: string; mimeType: string }>((resolve, reject) => {
      let audioChunks: Blob[] = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      
      recorder.onstop = () => {
        if (audioChunks.length === 0) {
          return reject(new Error("No audio data captured."));
        }

        const detectedMimeType = audioChunks[0].type || this.audioMimeTypeRef.current;
        if (!detectedMimeType) {
          return reject(new Error("Could not determine audio MIME type."));
        }

        const audioBlob = new Blob(audioChunks, { type: detectedMimeType });
        const reader = new FileReader();
        
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          if (!dataUrl || !dataUrl.startsWith('data:')) {
            return reject(new Error("Invalid data URL from FileReader."));
          }

          const separator = ';base64,';
          const separatorIndex = dataUrl.indexOf(separator);
          if (separatorIndex === -1) {
            return reject(new Error("Malformed base64 data URL."));
          }
          const base64Audio = dataUrl.substring(separatorIndex + separator.length);

          resolve({ audioData: base64Audio, mimeType: detectedMimeType });

          // Restart recording for next capture (only if not resetting)
          if (this.statusRef.current === AppStatus.ANALYZING && !this.isProcessingReset) {
            recorder.start();
          }
        };
        
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
        
        recorder.ondataavailable = null;
        recorder.onstop = null;
      };
      
      recorder.stop();
    });
  }

  private async requestSummary(): Promise<void> {
    if (!this.geminiService?.isConnected()) {
      this.log("Cannot request summary: Gemini service not connected.", LogLevel.WARN);
      return;
    }

    // Set reset flag to prevent new captures during summary processing
    this.isProcessingReset = true;

    const elapsedMinutes = Math.round((Date.now() - this.sessionStartTime) / 60000);
    const finalCaptureCount = this.captureCount;
    
    this.log(`Requesting summary for minute ${elapsedMinutes} (${finalCaptureCount} captures collected)`, LogLevel.INFO);
    this.log(`Setting reset flag - no new captures will be processed until summary completes`, LogLevel.INFO);

    // Enhanced summary prompt that breaks the "Received Dynamic Capture" pattern
    const summaryPrompt = `SUMMARY REQUEST - STOP responding with "Received Dynamic Capture" messages.

You have processed ${finalCaptureCount} dynamic sampling captures in the last 60 seconds. Now provide a comprehensive educational summary:

**IMPORTANT**: Do NOT respond with "Received Dynamic Capture X". Instead, provide the educational analysis below:

**Visual Changes**: Describe how the visual content evolved across all ${finalCaptureCount} captures
**Content Summary**: Extract and summarize the key educational points from audio and visual content
**Learning Insights**: Highlight the most important takeaways for someone learning this material
**Technical Details**: Note any significant changes in presentation style, slides, or teaching approach

Focus on creating educational value from the accumulated visual and audio content. This is a SUMMARY REQUEST - respond with analysis, not capture acknowledgments.`;

    // Use text-only method to avoid empty image error
    // Add a small delay to ensure all pending captures are processed before summary
    await new Promise(resolve => setTimeout(resolve, 500));
    
    this.log(`Sending summary request to Gemini (text-only, ${summaryPrompt.length} characters)`, LogLevel.INFO);
    this.geminiService.sendTextOnly(summaryPrompt);
    this.log(`Summary request sent successfully for minute ${elapsedMinutes}`, LogLevel.SUCCESS);
    
    // Atomically reset counters and clear reset flag
    this.captureCount = 0;
    this.nextCaptureId = 1;
    this.isProcessingReset = false;
    
    this.log(`✅ ATOMIC RESET COMPLETE: Counter reset from ${finalCaptureCount} to 0, nextCaptureId reset to 1`, LogLevel.SUCCESS);
    this.log(`Reset flag cleared - new captures can now be processed`, LogLevel.SUCCESS);
  }
}
