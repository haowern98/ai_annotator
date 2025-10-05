import React from 'react';
import { AppStatus, LogLevel } from '../types';
import LiveApiService from '../services/liveApiService';

type LogFunction = (message: string, level?: LogLevel) => void;

interface StreamingConfig {
  videoFrameRate: number; // FPS for video frames (e.g., 1-2)
  audioChunkMs: number; // Audio chunk duration in ms (e.g., 100ms)
  systemInstruction?: string;
}

interface StreamingCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
  onModelResponse: (text: string) => void;
  onError: (error: string) => void;
  onStatusChange: (status: AppStatus) => void;
}

export class ContinuousStreamingCapture {
  private config: StreamingConfig;
  private callbacks: StreamingCallbacks;
  private log: LogFunction;
  private liveApiService: LiveApiService | null = null;
  
  private videoRef: React.RefObject<HTMLVideoElement>;
  private canvasRef: React.RefObject<HTMLCanvasElement>;
  private mediaStream: MediaStream | null = null;
  
  private videoIntervalId: number | null = null;
  private audioContext: AudioContext | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private summaryIntervalId: number | null = null;
  
  private isRunning = false;
  private startTime: number = 0;

  constructor(
    config: StreamingConfig,
    callbacks: StreamingCallbacks,
    log: LogFunction,
    refs: {
      videoRef: React.RefObject<HTMLVideoElement>;
      canvasRef: React.RefObject<HTMLCanvasElement>;
    }
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.log = log;
    this.videoRef = refs.videoRef;
    this.canvasRef = refs.canvasRef;
  }

  public setLiveApiService(service: LiveApiService): void {
    this.liveApiService = service;
  }

  public setMediaStream(stream: MediaStream): void {
    this.mediaStream = stream;
  }

  public async start(): Promise<void> {
    if (!this.liveApiService?.isConnected()) {
      this.log("Cannot start streaming: Live API service not connected.", LogLevel.ERROR);
      return;
    }

    if (!this.mediaStream) {
      this.log("Cannot start streaming: Media stream not available.", LogLevel.ERROR);
      return;
    }

    this.log("Starting continuous audio/video streaming with turn detection...", LogLevel.SUCCESS);
    this.isRunning = true;
    this.startTime = Date.now();

    // Start video frame streaming
    this.startVideoStreaming();

    // Start audio streaming
    await this.startAudioStreaming();

    this.log("Streaming started. Model will respond automatically when speaker finishes talking.", LogLevel.SUCCESS);
  }

  public stop(): void {
    this.log("Stopping continuous streaming.", LogLevel.INFO);
    this.isRunning = false;

    // Stop video streaming
    if (this.videoIntervalId) {
      window.clearInterval(this.videoIntervalId);
      this.videoIntervalId = null;
    }

    // Stop audio streaming
    this.stopAudioStreaming();
  }

  private startVideoStreaming(): void {
    const frameIntervalMs = 1000 / this.config.videoFrameRate;
    
    this.log(`Starting video streaming at ${this.config.videoFrameRate} FPS (every ${frameIntervalMs}ms)`, LogLevel.INFO);

    this.videoIntervalId = window.setInterval(() => {
      this.captureAndSendVideoFrame();
    }, frameIntervalMs);

    // Send first frame immediately
    this.captureAndSendVideoFrame();
  }

  private captureAndSendVideoFrame(): void {
    if (!this.isRunning || !this.videoRef.current || !this.canvasRef.current || !this.liveApiService) {
      return;
    }

    const video = this.videoRef.current;
    const canvas = this.canvasRef.current;

    // Check if video has valid dimensions
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    // Draw video frame to canvas
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      this.log("Failed to get canvas 2D context.", LogLevel.ERROR);
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Convert to base64 JPEG
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const base64Data = dataUrl.split(',')[1];

    // Send to Live API
    this.liveApiService.sendVideoFrame(base64Data);
  }

  private async startAudioStreaming(): Promise<void> {
    const audioTracks = this.mediaStream?.getAudioTracks();
    
    if (!audioTracks || audioTracks.length === 0) {
      this.log("No audio tracks available. Continuing with video only.", LogLevel.WARN);
      return;
    }

    try {
      // Create audio context
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      
      // Create media stream source
      const audioStream = new MediaStream([audioTracks[0]]);
      this.mediaStreamSource = this.audioContext.createMediaStreamSource(audioStream);

      // Create ScriptProcessorNode for audio processing
      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessor.onaudioprocess = (e) => {
        if (!this.isRunning || !this.liveApiService?.isConnected()) {
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert Float32Array to Int16Array (PCM 16-bit)
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Convert to base64 string
        const base64Audio = this.arrayBufferToBase64(pcmData.buffer);

        // Send PCM data to Live API
        this.liveApiService.sendRealtimeAudio(
          base64Audio,
          `audio/pcm;rate=${this.audioContext!.sampleRate}`
        );
      };

      // Connect nodes
      this.mediaStreamSource.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);

      this.log(`Audio streaming started at ${this.audioContext.sampleRate}Hz`, LogLevel.SUCCESS);
      
    } catch (error) {
      this.log(
        `Failed to start audio streaming: ${error instanceof Error ? error.message : 'Unknown error'}`,
        LogLevel.ERROR
      );
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private stopAudioStreaming(): void {
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.mediaStreamSource) {
      this.mediaStreamSource.disconnect();
      this.mediaStreamSource = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Signal end of audio stream to Live API
    if (this.liveApiService?.isConnected()) {
      this.liveApiService.endAudioStream();
    }

    this.log("Audio streaming stopped.", LogLevel.INFO);
  }
}
