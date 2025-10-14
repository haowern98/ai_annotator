import React from 'react';
import { AppStatus, LogLevel } from '../types';
import LiveApiService from '../services/liveApiService';

type LogFunction = (message: string, level?: LogLevel) => void;

interface StreamingConfig {
  videoFrameRate: number; // FPS for video frames (e.g., 1-2)
  audioChunkMs: number; // Audio chunk duration in ms (e.g., 100ms)
}

interface StreamingCallbacks {
  // Callbacks are now handled directly by the service instances
  onError: (error: string) => void;
  onStatusChange: (status: AppStatus) => void;
}

export class ContinuousStreamingCapture {
  private config: StreamingConfig;
  private callbacks: StreamingCallbacks;
  private log: LogFunction;
  
  // References to the two independent API services
  private transcriptService: LiveApiService | null = null;
  private replyService: LiveApiService | null = null;
  
  private videoRef: React.RefObject<HTMLVideoElement>;
  private canvasRef: React.RefObject<HTMLCanvasElement>;
  private mediaStream: MediaStream | null = null;
  
  private videoIntervalId: number | null = null;
  private audioContext: AudioContext | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private mediaStreamSource: MediaStreamAudioSourceNode | null = null;
  
  private isRunning = false;
  
  // Audio buffering for transcription
  private isTranscribing = false;
  private audioBuffer: Array<{data: string, mimeType: string}> = [];

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

  // Set both API service instances
  public setApiServices(services: { transcriptService: LiveApiService; replyService: LiveApiService }): void {
    this.transcriptService = services.transcriptService;
    this.replyService = services.replyService;
  }

  public setMediaStream(stream: MediaStream): void {
    this.mediaStream = stream;
  }

  // Control transcription state and manage audio buffering
  public setTranscribing(isTranscribing: boolean): void {
    const wasTranscribing = this.isTranscribing;
    this.isTranscribing = isTranscribing;
    
    if (isTranscribing && !wasTranscribing) {
      this.log("Buffering audio - transcription in progress", LogLevel.INFO);
    } else if (!isTranscribing && wasTranscribing) {
      this.log(`Flushing ${this.audioBuffer.length} buffered audio chunks - transcription complete`, LogLevel.SUCCESS);
      this.flushAudioBuffer();
    }
  }

  // Send all buffered audio to transcript service
  private flushAudioBuffer(): void {
    if (this.audioBuffer.length === 0) return;
    
    const bufferSize = this.audioBuffer.length;
    
    // Send all buffered audio chunks
    while (this.audioBuffer.length > 0) {
      const buffered = this.audioBuffer.shift()!;
      this.transcriptService?.sendRealtimeAudio(buffered.data, buffered.mimeType);
    }
    
    this.log(`Sent ${bufferSize} buffered audio chunks to transcript service`, LogLevel.SUCCESS);
  }

  public async start(): Promise<void> {
    if (!this.transcriptService?.isConnected() || !this.replyService?.isConnected()) {
      this.log("Cannot start streaming: One or both API services are not connected.", LogLevel.ERROR);
      return;
    }

    if (!this.mediaStream) {
      this.log("Cannot start streaming: Media stream not available.", LogLevel.ERROR);
      return;
    }

    this.log("Starting dual-session continuous audio/video streaming...", LogLevel.SUCCESS);
    this.isRunning = true;

    // Start video and audio streaming
    // this.startVideoStreaming();
    await this.startAudioStreaming();

    this.log("Streaming started to both sessions.", LogLevel.SUCCESS);
  }

  public stop(): void {
    this.log("Stopping continuous streaming to both sessions.", LogLevel.INFO);
    this.isRunning = false;

    if (this.videoIntervalId) {
      window.clearInterval(this.videoIntervalId);
      this.videoIntervalId = null;
    }

    // Clear audio buffer
    this.audioBuffer = [];
    this.isTranscribing = false;

    this.stopAudioStreaming();
  }

  private startVideoStreaming(): void {
    const frameIntervalMs = 1000 / this.config.videoFrameRate;
    this.videoIntervalId = window.setInterval(() => {
      this.captureAndSendVideoFrame();
    }, frameIntervalMs);
    this.captureAndSendVideoFrame();
  }

  private captureAndSendVideoFrame(): void {
    if (!this.isRunning || !this.videoRef.current || !this.canvasRef.current) return;

    const video = this.videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    const canvas = this.canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const base64Data = dataUrl.split(',')[1];

    // Send the same video frame to both sessions
    // this.transcriptService?.sendVideoFrame(base64Data);
    // this.replyService?.sendVideoFrame(base64Data);
  }

  private async startAudioStreaming(): Promise<void> {
    const audioTracks = this.mediaStream?.getAudioTracks();
    if (!audioTracks || audioTracks.length === 0) {
      this.log("No audio tracks available.", LogLevel.WARN);
      return;
    }

    try {
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const audioStream = new MediaStream([audioTracks[0]]);
      this.mediaStreamSource = this.audioContext.createMediaStreamSource(audioStream);
      
      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessor.onaudioprocess = (e) => {
        if (!this.isRunning) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const base64Audio = this.arrayBufferToBase64(pcmData.buffer);
        const mimeType = `audio/pcm;rate=${this.audioContext!.sampleRate}`;

        // Audio buffering logic
        if (this.isTranscribing) {
          // Buffer audio during transcription
          this.audioBuffer.push({ data: base64Audio, mimeType });
          
          // Prevent buffer from growing too large (max 50 chunks ~5 seconds at 100ms chunks)
          if (this.audioBuffer.length > 50) {
            this.log("Audio buffer full, dropping oldest chunk", LogLevel.WARN);
            this.audioBuffer.shift();
          }
        } else {
          // Not transcribing - flush any buffered audio first
          if (this.audioBuffer.length > 0) {
            this.flushAudioBuffer();
          }
          
          // Send current audio chunk to transcript session
          this.transcriptService?.sendRealtimeAudio(base64Audio, mimeType);
        }
      };

      this.mediaStreamSource.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);
      this.log(`Audio streaming started for both sessions at ${this.audioContext.sampleRate}Hz`, LogLevel.SUCCESS);
    } catch (error) {
      this.log(`Failed to start audio streaming: ${error instanceof Error ? error.message : 'Unknown'}`, LogLevel.ERROR);
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
    
    // Signal end of audio to transcript session only
    this.transcriptService?.endAudioStream();

    this.log("Audio streaming stopped for both sessions.", LogLevel.INFO);
  }
}
