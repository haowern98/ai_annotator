import React from 'react';
import { AppStatus, LogLevel } from '../types';
import GeminiService from '../services/geminiService';

type LogFunction = (message: string, level?: LogLevel) => void;

interface RealtimeModeConfig {
  captureIntervalMs: number;
  sessionRefreshIntervalMs: number;
  realtimePrompt: string;
}

interface RealtimeModeCallbacks {
  onRealtimeResponse: (response: string) => void;
  onError: (error: string) => void;
  onStatusChange: (status: AppStatus) => void;
}

export class RealtimeMode {
  private config: RealtimeModeConfig;
  private callbacks: RealtimeModeCallbacks;
  private log: LogFunction;
  private geminiService: GeminiService | null = null;
  
  private videoRef: React.RefObject<HTMLVideoElement>;
  private canvasRef: React.RefObject<HTMLCanvasElement>;
  private mediaRecorderRef: React.RefObject<MediaRecorder | null>;
  private audioMimeTypeRef: React.RefObject<string>;
  private statusRef: React.RefObject<AppStatus>;
  
  private captureIntervalId: number | null = null;
  private sessionRefreshIntervalId: number | null = null;
  private sessionStartTime: number = 0;
  private isStreaming = false;

  constructor(
    config: RealtimeModeConfig,
    callbacks: RealtimeModeCallbacks,
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
      this.log("Cannot start realtime mode: Gemini service not connected.", LogLevel.ERROR);
      return;
    }

    this.log(`Starting realtime mode with ${this.config.captureIntervalMs / 1000}s intervals`, LogLevel.SUCCESS);
    this.isStreaming = true;
    this.sessionStartTime = Date.now();

    // Start continuous capture every second
    this.captureIntervalId = window.setInterval(() => {
      this.captureAndStreamImmediately();
    }, this.config.captureIntervalMs);

    // Start session refresh timer
    this.sessionRefreshIntervalId = window.setInterval(() => {
      this.refreshSessionIfNeeded();
    }, 30000); // Check every 30 seconds

    // Capture first frame immediately
    this.captureAndStreamImmediately();
  }

  public stop(): void {
    this.log("Stopping realtime mode.", LogLevel.INFO);
    
    this.isStreaming = false;
    
    if (this.captureIntervalId) {
      window.clearInterval(this.captureIntervalId);
      this.captureIntervalId = null;
    }
    
    if (this.sessionRefreshIntervalId) {
      window.clearInterval(this.sessionRefreshIntervalId);
      this.sessionRefreshIntervalId = null;
    }
  }

  private async refreshSessionIfNeeded(): Promise<void> {
    const sessionAge = Date.now() - this.sessionStartTime;
    
    // Refresh every 80 seconds to stay well under 2-minute limit
    if (sessionAge > 80000) {
      this.log("Refreshing session to avoid timeout...", LogLevel.INFO);
      
      // This would require App.tsx to handle session recreation
      this.callbacks.onStatusChange(AppStatus.CONNECTING);
      
      // Reset timer
      this.sessionStartTime = Date.now();
      
      this.log("Session refresh completed.", LogLevel.SUCCESS);
    }
  }

  private async captureAndStreamImmediately(): Promise<void> {
    if (!this.isStreaming || !this.videoRef.current || !this.canvasRef.current || !this.geminiService?.isConnected()) {
      return;
    }

    const currentStream = this.videoRef.current.srcObject as MediaStream | null;
    if (!currentStream || !currentStream.active) {
      this.log("Media stream is not active. Stopping realtime mode.", LogLevel.WARN);
      this.callbacks.onError("Media stream became inactive");
      return;
    }

    const video = this.videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      this.log("Video has no dimensions yet, skipping capture.", LogLevel.WARN);
      return;
    }

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

    // 2. Generate realtime prompt
    const prompt = this.generateRealtimePrompt();

    // 3. Capture Audio Snippet (1 second chunk)
    const recorder = this.mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      this.log("Audio recorder not ready. Sending frame without audio.", LogLevel.WARN);
      this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);
      return;
    }

    try {
      const audioData = await this.captureAudioChunk(recorder);
      
      // Send immediately to Gemini
      this.geminiService.sendFrame(videoBase64Data, audioData.audioData, audioData.mimeType, prompt);
      
      this.log(`Realtime frame sent (${Math.round(videoBase64Data.length * 3 / 4 / 1024)}KB image, ${Math.round(audioData.audioData.length * 3 / 4 / 1024)}KB audio)`);
      
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Error capturing audio: ${message}. Sending video only.`, LogLevel.WARN);
      
      this.geminiService.sendFrame(videoBase64Data, undefined, undefined, prompt);

      // Restart recording if needed
      if (this.mediaRecorderRef.current?.state === 'inactive' && this.statusRef.current === AppStatus.ANALYZING) {
        this.mediaRecorderRef.current.start();
      }
    }
  }

  private async captureAudioChunk(recorder: MediaRecorder): Promise<{ audioData: string; mimeType: string }> {
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

          // Restart recording for next capture
          if (this.statusRef.current === AppStatus.ANALYZING && this.isStreaming) {
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

  private generateRealtimePrompt(): string {
    return `${this.config.realtimePrompt}

Analyze what's happening in this screen capture and audio segment right now. Provide a brief, immediate analysis of:
- What is currently being shown on screen
- What the speaker is currently saying or explaining
- The current learning context or topic

Keep the response concise but informative - this is real-time streaming analysis.`;
  }
}