import React from 'react';
import { AppStatus, LogLevel } from '../types';
import GeminiService from '../services/geminiService';

type LogFunction = (message: string, level?: LogLevel) => void;

interface VideoModeConfig {
  dataCollectionIntervalMs: number;
  setsPerMinute: number;
  videoModePrompt: string;
}

interface VideoModeCallbacks {
  onSummary: (summary: string) => void;
  onError: (error: string) => void;
  onStatusChange: (status: AppStatus) => void;
}

export class VideoModeCapture {
  private config: VideoModeConfig;
  private callbacks: VideoModeCallbacks;
  private log: LogFunction;
  private geminiService: GeminiService | null = null;
  
  private videoRef: React.RefObject<HTMLVideoElement>;
  private canvasRef: React.RefObject<HTMLCanvasElement>;
  private mediaRecorderRef: React.RefObject<MediaRecorder | null>;
  private audioMimeTypeRef: React.RefObject<string>;
  private statusRef: React.RefObject<AppStatus>;
  
  private captureIntervalId: number | null = null;
  private captureCount = 0;

  constructor(
    config: VideoModeConfig,
    callbacks: VideoModeCallbacks,
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
      this.log("Cannot start video mode: Gemini service not connected.", LogLevel.ERROR);
      return;
    }

    this.log(`Starting video mode capture every ${this.config.dataCollectionIntervalMs / 1000}s`, LogLevel.SUCCESS);
    this.captureCount = 0;

    // Start capturing data every 10 seconds
    this.captureIntervalId = window.setInterval(() => {
      this.captureAndSendData();
    }, this.config.dataCollectionIntervalMs);

    // Capture first frame immediately
    this.captureAndSendData();
  }

  public stop(): void {
    this.log("Stopping video mode capture.", LogLevel.INFO);
    
    if (this.captureIntervalId) {
      window.clearInterval(this.captureIntervalId);
      this.captureIntervalId = null;
    }
    
    this.captureCount = 0;
  }

  private async captureAndSendData(): Promise<void> {
    if (!this.videoRef.current || !this.canvasRef.current || !this.geminiService?.isConnected()) {
      this.log("Skipping data capture: core dependencies not ready.", LogLevel.WARN);
      return;
    }

    const currentStream = this.videoRef.current.srcObject as MediaStream | null;
    if (!currentStream || !currentStream.active) {
      this.log("Media stream is not active. Stopping video mode.", LogLevel.WARN);
      this.callbacks.onError("Media stream became inactive");
      return;
    }

    const video = this.videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      this.log("Video has no dimensions yet, skipping data capture.", LogLevel.WARN);
      return;
    }

    // Increment counter and check for cycle completion BEFORE doing anything else
    this.captureCount++;
    this.log(`Raw counter incremented to: ${this.captureCount}`);
    
    // If we just completed a full cycle, reset immediately
    if (this.captureCount > this.config.setsPerMinute) {
      this.log(`Cycle completed! Resetting counter from ${this.captureCount} to 1`, LogLevel.SUCCESS);
      this.captureCount = 1;
    }
    
    this.log(`Capturing data point ${this.captureCount}/${this.config.setsPerMinute}...`);

    // Check if we should request summary after this capture
    const shouldRequestSummary = this.captureCount >= this.config.setsPerMinute;

    // 1. Capture Video Frame
    const canvas = this.canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.log("Failed to get 2D context from canvas.", LogLevel.ERROR);
      return;
    }
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const videoBase64Data = dataUrl.split(',')[1];

    // 2. Generate appropriate prompt based on data point number
    const prompt = this.generatePromptForDataPoint(this.captureCount);

    // 3. Capture Audio Snippet
    const recorder = this.mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      this.log("Audio recorder not ready. Sending frame without audio.", LogLevel.WARN);
      this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);
      
      // Handle summary request if needed
      if (shouldRequestSummary) {
        this.handleSummaryRequest();
      }
      return;
    }

    const audioPromise = new Promise<{ audioData: string; mimeType: string }>((resolve, reject) => {
      let audioChunks: Blob[] = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      
      recorder.onstop = () => {
        if (audioChunks.length === 0) {
          return reject(new Error("No audio data was captured in the interval."));
        }

        const detectedMimeType = audioChunks[0].type || this.audioMimeTypeRef.current;
        if (!detectedMimeType) {
          return reject(new Error("Could not determine audio MIME type from data blobs."));
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
            return reject(new Error("Malformed base64 data URL: ';base64,' separator not found."));
          }
          const base64Audio = dataUrl.substring(separatorIndex + separator.length);

          resolve({ audioData: base64Audio, mimeType: detectedMimeType });

          // Restart recording for next capture if still analyzing
          if (this.statusRef.current === AppStatus.ANALYZING) {
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

    try {
      const { audioData, mimeType } = await audioPromise;
      
      // Send data to Gemini with appropriate prompt
      this.geminiService.sendFrame(videoBase64Data, audioData, mimeType, prompt);
      
      this.log(`Data point ${this.captureCount} sent to Gemini (${Math.round(videoBase64Data.length * 3 / 4 / 1024)}KB image, ${Math.round(audioData.length * 3 / 4 / 1024)}KB audio)`);
      
      // Handle summary request if needed
      if (shouldRequestSummary) {
        this.handleSummaryRequest();
      }
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Error capturing audio for data point ${this.captureCount}: ${message}. Sending video only.`, LogLevel.WARN);
      
      this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);

      // Restart recording even on failure
      if (this.mediaRecorderRef.current?.state === 'inactive' && this.statusRef.current === AppStatus.ANALYZING) {
        this.mediaRecorderRef.current.start();
      }
      
      // Handle summary request if needed
      if (shouldRequestSummary) {
        this.handleSummaryRequest();
      }
    }
  }

  private generatePromptForDataPoint(dataPointNumber: number): string {
    if (dataPointNumber === 1) {
      // Data Point 1: Full instructions + response control
      return `You are analyzing a lecture/presentation through 10-second data segments. You will receive 12 sets of data per minute (screenshot + 5-second audio). I will send sets 1-5 for you to hold in context, then set 6 will request a comprehensive summary.

For context sets (1-12): Add the screenshot and audio to your memory and respond only with "Received Data [number]".

${this.config.videoModePrompt}

This is data set 1. Respond only with "Received Data 1".`;
    } else if (dataPointNumber >= 2 && dataPointNumber <= 11) {
      // Data Points 2-11: Simple holding instruction
      return `This is data set ${dataPointNumber}. Add this screenshot and audio to your memory with the previous sets. Respond only with "Received Data ${dataPointNumber}".`;
    } else if (dataPointNumber === 12) {
      // Data Point 12: Final set + summary request
      return `This is data set 12, the final set. Add this to your memory, then provide the comprehensive summary of all 12 data sets using the format specified initially. 

First respond with "Received Data 12", then provide:

1. Individual 5-second summaries for each data point (2 sentences each covering visual and audio content):
   - Data Point 1 (0-5 seconds)
   - Data Point 2 (5-10 seconds) 
   - Data Point 3 (10-15 seconds)
   - Data Point 4 (15-20 seconds)
   - Data Point 5 (20-25 seconds)
   - Data Point 6 (25-30 seconds)
   - Data Point 7 (30-35 seconds)
   - Data Point 8 (35-40 seconds)
   - Data Point 9 (40-45 seconds)
   - Data Point 10 (45-50 seconds)
   - Data Point 11 (50-55 seconds)
   - Data Point 12 (55-60 seconds)

2. Then provide the full comprehensive analysis of the entire 60-second period using the format specified in the initial instructions.`;
    } else {
      // Fallback (shouldn't happen with proper counter reset)
      return `This is data set ${dataPointNumber}. Add this screenshot and audio to your memory. Respond only with "Received Data ${dataPointNumber}".`;
    }
  }

  private handleSummaryRequest(): void {
    this.log(`Data point 12 includes summary request. Next cycle will auto-reset.`, LogLevel.INFO);
    this.captureCount = 0;
  }


}
