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
  private isFirstCapture = true;

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
    this.isFirstCapture = true;

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
    this.isFirstCapture = true;
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

    this.captureCount++;
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

    // 2. Capture Audio Snippet
    const recorder = this.mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      this.log("Audio recorder not ready. Sending frame without audio.", LogLevel.WARN);
      const prompt = this.isFirstCapture ? this.config.videoModePrompt : undefined;
      this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);
      if (this.isFirstCapture) this.isFirstCapture = false;
      
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
      const prompt = this.isFirstCapture ? this.config.videoModePrompt : undefined;
      
      // Send data to Gemini without expecting immediate response
      this.geminiService.sendFrame(videoBase64Data, audioData, mimeType, prompt);
      
      if (this.isFirstCapture) {
        this.isFirstCapture = false;
      }
      
      this.log(`Data point ${this.captureCount} sent to Gemini (${Math.round(videoBase64Data.length * 3 / 4 / 1024)}KB image, ${Math.round(audioData.length * 3 / 4 / 1024)}KB audio)`);
      
      // Handle summary request if needed
      if (shouldRequestSummary) {
        this.handleSummaryRequest();
      }
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Error capturing audio for data point ${this.captureCount}: ${message}. Sending video only.`, LogLevel.WARN);
      
      const prompt = this.isFirstCapture ? this.config.videoModePrompt : undefined;
      this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);
      
      if (this.isFirstCapture) {
        this.isFirstCapture = false;
      }

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

  private handleSummaryRequest(): void {
    this.log(`Requesting summary after collecting ${this.captureCount} data points.`, LogLevel.INFO);
    
    // Reset counter immediately to prevent race conditions
    this.captureCount = 0;
    
    // Request summary with a small delay to ensure the last data point is processed
    setTimeout(() => {
      if (this.geminiService?.isConnected()) {
        this.geminiService.requestSummary();
      }
    }, 100);
  }


}
