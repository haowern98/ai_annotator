import React from 'react';
import { AppStatus, LogLevel } from '../types';
import LiveApiService from './liveApiService';
import { ContinuousStreamingCapture } from '../utils/continuousStreaming';

// Configuration for the two sessions
const TRANSCRIPT_PROMPT = `You are transcribing audio from an interview.

When the speaker finishes talking (turn complete), transcribe their ENTIRE statement from start to finish. Accumulate all words spoken during this complete turn.

Example:
- Speaker says: "Hello, how are you doing today? I wanted to ask about your experience."
- You respond: {"transcript": "Hello, how are you doing today? I wanted to ask about your experience."}

Do NOT respond with partial sentences or fragments. Wait for the complete turn, then provide everything.

If the turn contains no clear speech, do NOT respond.

Format: {"transcript": "[complete turn from start to finish]"}`;

const REPLY_PROMPT = `You are interviewing for a software engineer position at a software engineering company.
Respond ONLY with a valid JSON object in the following format:
{
  "reply": "[Your response to the interviewer's question or statement. If the question is short, reply with a single sentence. If the question is more detailed, provide a more detailed response with examples and elaboration, but still be concise]"
}`;

const STREAMING_CONFIG = {
  videoFrameRate: 1,
  audioChunkMs: 100,
};

type LogFunction = (message: string, level?: LogLevel) => void;

interface TranscriptItem {
  timestamp: string;
  text: string;
}

interface ReplyItem {
  timestamp: string;
  text: string;
}

interface DualSessionCallbacks {
  onStatusChange: (status: AppStatus) => void;
  onError: (error: string) => void;
  onTranscriptUpdate: (transcripts: TranscriptItem[], currentTranscript: string) => void;
  onReplyUpdate: (replies: ReplyItem[], currentReply: string) => void;
}

export class DualGeminiSessionManager {
  private transcriptService: LiveApiService | null = null;
  private replyService: LiveApiService | null = null;
  private streamingCapture: ContinuousStreamingCapture | null = null;
  
  private transcripts: TranscriptItem[] = [];
  private currentTranscript: string = '';
  private replies: ReplyItem[] = [];
  private currentReply: string = '';
  
  private transcriptQueue: string[] = [];
  private isReplyGenerating: boolean = false;
  
  private mediaStream: MediaStream | null = null;
  private callbacks: DualSessionCallbacks;
  private log: LogFunction;
  
  private videoRef: React.RefObject<HTMLVideoElement>;
  private canvasRef: React.RefObject<HTMLCanvasElement>;

  constructor(
    callbacks: DualSessionCallbacks,
    log: LogFunction,
    refs: {
      videoRef: React.RefObject<HTMLVideoElement>;
      canvasRef: React.RefObject<HTMLCanvasElement>;
    }
  ) {
    this.callbacks = callbacks;
    this.log = log;
    this.videoRef = refs.videoRef;
    this.canvasRef = refs.canvasRef;
  }

  public async start(apiKey: string): Promise<void> {
    this.log('Dual Session Manager: Starting...');
    
    if (!apiKey) {
      const msg = "API_KEY environment variable not set.";
      this.log(msg, LogLevel.ERROR);
      this.callbacks.onError(msg);
      this.callbacks.onStatusChange(AppStatus.ERROR);
      return;
    }

    // Reset state
    this.cleanup();
    this.transcripts = [];
    this.currentTranscript = '';
    this.replies = [];
    this.currentReply = '';
    this.transcriptQueue = [];
    this.isReplyGenerating = false;
    
    this.callbacks.onTranscriptUpdate([], '');
    this.callbacks.onReplyUpdate([], '');
    
    this.log('Initializing dual-session Live API...');
    this.callbacks.onStatusChange(AppStatus.CAPTURING);

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.mediaStream = stream;
      this.callbacks.onStatusChange(AppStatus.CONNECTING);

      // Create both service instances
      const service1 = new LiveApiService(apiKey, this.log);
      const service2 = new LiveApiService(apiKey, this.log);

      // Connect Transcript Service
      const connectTranscript = service1.connect({
        onTranscript: (text, isFinal) => {
          if (!isFinal) {
            this.currentTranscript = text;
            this.callbacks.onTranscriptUpdate(this.transcripts, this.currentTranscript);
          }
        },
        onModelResponse: (text) => {
          try {
            // Clean the text: Sometimes the AI wraps JSON in markdown
            const cleanText = text.replace(/```json|```/g, '').trim();
            
            // Parse the JSON string into a JavaScript object
            const parsed = JSON.parse(cleanText);
            
            // Safely access the 'transcript' property and update the state
            if (parsed.transcript) {
              const transcriptText = parsed.transcript;
              this.transcripts.push({ 
                timestamp: new Date().toLocaleTimeString(), 
                text: transcriptText 
              });
              this.log(`Parsed transcript: ${transcriptText.substring(0,30)}...`);
              
              // Add transcript to queue for reply service
              this.transcriptQueue.push(transcriptText);
              this.processTranscriptQueue();
            }
          } catch (e) {
            // If parsing fails, log an error to help with debugging
            this.log(`Failed to parse JSON from transcript service: ${text}`, LogLevel.ERROR);
          }
          this.currentTranscript = '';
          this.callbacks.onTranscriptUpdate(this.transcripts, this.currentTranscript);
        },
        onError: (e) => { 
          this.callbacks.onError(`Transcript Service Error: ${e}`);
          this.callbacks.onStatusChange(AppStatus.ERROR);
          this.cleanup();
        },
        onClose: () => this.log('Transcript service closed.'),
      }, TRANSCRIPT_PROMPT);
      
      // Connect Reply Service
      const connectReply = service2.connect({
        onTranscript: () => {},
        onPartialResponse: (textChunk) => {
          // Show a placeholder "..." instead of the raw JSON chunks
          this.currentReply = this.currentReply === '' ? '...' : this.currentReply;
          this.isReplyGenerating = true;
          this.callbacks.onReplyUpdate(this.replies, this.currentReply);
        },
        onModelResponse: (text) => {
          try {
            // Clean the text
            const cleanText = text.replace(/```json|```/g, '').trim();
            
            // Parse the JSON
            const parsed = JSON.parse(cleanText);
            
            // Access the 'reply' property and update state
            if (parsed.reply) {
              const replyText = parsed.reply;
              this.replies.push({ 
                timestamp: new Date().toLocaleTimeString(), 
                text: replyText 
              });
              this.log(`Parsed reply: ${replyText.substring(0,30)}...`, LogLevel.SUCCESS);
            }
          } catch (e) {
            // Log parsing errors
            this.log(`Failed to parse JSON from reply service: ${text}`, LogLevel.ERROR);
          }
          // Clear the "..." placeholder once the final reply is ready
          this.currentReply = '';
          this.isReplyGenerating = false;
          this.callbacks.onReplyUpdate(this.replies, this.currentReply);
          
          // Process next item in queue
          this.processTranscriptQueue();
        },
        onError: (e) => { 
          this.callbacks.onError(`Reply Service Error: ${e}`);
          this.callbacks.onStatusChange(AppStatus.ERROR);
          this.cleanup();
        },
        onClose: () => this.log('Reply service closed.'),
      }, REPLY_PROMPT);

      await Promise.all([connectTranscript, connectReply]);

      this.log('Both API services connected successfully.', LogLevel.SUCCESS);
      this.transcriptService = service1;
      this.replyService = service2;
      this.callbacks.onStatusChange(AppStatus.ANALYZING);

      // Set up video and streaming
      this.setupVideoAndStreaming();

    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      this.log(`Failed to start session: ${message}`, LogLevel.ERROR);
      this.callbacks.onError(`Failed to start session: ${message}`);
      this.callbacks.onStatusChange(AppStatus.ERROR);
      this.cleanup();
    }
  }

  private setupVideoAndStreaming(): void {
    if (!this.mediaStream || !this.videoRef.current) return;

    const video = this.videoRef.current;
    video.srcObject = this.mediaStream;

    const handleVideoReady = () => {
      if (!this.mediaStream || !this.transcriptService || !this.replyService) return;

      this.log('Video ready. Initializing continuous streaming...', LogLevel.SUCCESS);
      const capture = new ContinuousStreamingCapture(
        STREAMING_CONFIG,
        {
          onError: (error) => { 
            this.callbacks.onError(`Streaming Error: ${error}`);
            this.callbacks.onStatusChange(AppStatus.ERROR);
          },
          onStatusChange: (newStatus) => this.callbacks.onStatusChange(newStatus),
        },
        this.log,
        { videoRef: this.videoRef, canvasRef: this.canvasRef }
      );
      
      // Set both services and the media stream
      capture.setApiServices({ 
        transcriptService: this.transcriptService, 
        replyService: this.replyService 
      });
      capture.setMediaStream(this.mediaStream);
      this.streamingCapture = capture;

      capture.start();
      this.log('Continuous streaming started for both sessions!', LogLevel.SUCCESS);
    };

    video.addEventListener('loadedmetadata', handleVideoReady);
    if (video.readyState >= 1) handleVideoReady();
  }

  private processTranscriptQueue(): void {
    if (!this.replyService || this.transcriptQueue.length === 0 || this.isReplyGenerating) {
      return;
    }

    // Take the first transcript from queue
    const nextTranscript = this.transcriptQueue.shift();
    if (!nextTranscript) return;
    
    this.log(`Sending transcript to reply service: "${nextTranscript.substring(0, 50)}..."`);
    
    // Send transcript as text to reply service
    this.replyService.sendText(`Interviewer said: "${nextTranscript}". Please provide your response.`);
  }

  public stop(): void {
    this.log('Dual Session Manager: Stopping...');
    this.callbacks.onStatusChange(AppStatus.STOPPING);
    this.cleanup();
    this.transcriptQueue = [];
    this.isReplyGenerating = false;
    this.callbacks.onStatusChange(AppStatus.IDLE);
    this.log('Analysis stopped', LogLevel.SUCCESS);
  }

  private cleanup(): void {
    if (this.streamingCapture) {
      this.streamingCapture.stop();
      this.streamingCapture = null;
    }
    
    this.transcriptService?.disconnect();
    this.replyService?.disconnect();
    this.transcriptService = null;
    this.replyService = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
  }

  public getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }
}
