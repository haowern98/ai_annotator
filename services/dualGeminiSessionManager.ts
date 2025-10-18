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

const REPLY_PROMPT = `You are a Malaysian who is studying at National University of Singapore who is interviewing for a software engineer position at a software engineering company.
Respond ONLY with a valid JSON object in the following format:
{
  "reply": "[Your response to the interviewer's question or statement. If the question is short, reply with a single sentence. If the question is more detailed, provide a more detailed response with examples and elaboration, but still be concise]"
}`;

const STREAMING_CONFIG = {
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
  
  // Track if streaming has been initialized to prevent race conditions
  private streamingInitialized: boolean = false;

  constructor(
    callbacks: DualSessionCallbacks,
    log: LogFunction
  ) {
    this.callbacks = callbacks;
    this.log = log;
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
    this.streamingInitialized = false;
    
    this.callbacks.onTranscriptUpdate([], '');
    this.callbacks.onReplyUpdate([], '');
    
    this.log('Initializing dual-session Live API...');
    this.callbacks.onStatusChange(AppStatus.CAPTURING);

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.mediaStream = stream;
      
      // Verify audio tracks are present
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        this.log('WARNING: No audio tracks in media stream. Audio capture may not work.', LogLevel.WARN);
      } else {
        this.log(`Audio tracks found: ${audioTracks.length} track(s)`, LogLevel.SUCCESS);
      }
      
      this.callbacks.onStatusChange(AppStatus.CONNECTING);

      // Create both service instances with unique session keys for separate handle storage
      const service1 = new LiveApiService(apiKey, this.log, 'transcript');
      const service2 = new LiveApiService(apiKey, this.log, 'reply');

      // Connect Transcript Service
      const connectTranscript = service1.connect({
        onTranscript: (text, isFinal) => {
          if (!isFinal) {
            this.currentTranscript = text;
            this.callbacks.onTranscriptUpdate(this.transcripts, this.currentTranscript);
          }
        },
        onModelTurnStart: () => {
          // CRITICAL: Model started responding - start buffering IMMEDIATELY
          if (this.streamingCapture) {
            this.streamingCapture.setTranscribing(true);
          }
        },
        onPartialResponse: (textChunk) => {
          // Partial text arriving - buffering should already be active from onModelTurnStart
        },
        onModelResponse: (text) => {
          try {
            // Clean the text: Sometimes the AI wraps JSON in markdown
            const cleanText = text.replace(/```json|```/g, '').trim();
            
            // Skip obviously incomplete responses (interrupted)
            if (cleanText === '{"transcript": "' || cleanText === '{"' || cleanText === '{"..."' || !cleanText.endsWith('}')) {
              this.log('Ignoring incomplete/interrupted transcript', LogLevel.WARN);
              // Resume audio streaming for incomplete responses
              if (this.streamingCapture) {
                this.streamingCapture.setTranscribing(false);
              }
              return;
            }
            
            // Parse the JSON string into a JavaScript object
            const parsed = JSON.parse(cleanText);
            
            // Safely access the 'transcript' property and update the state
            if (parsed.transcript) {
              const transcriptText = parsed.transcript;
              
              // Filter out empty transcripts
              if (!transcriptText || transcriptText.trim().length === 0) {
                this.log('Ignoring empty transcript', LogLevel.WARN);
                // Resume audio streaming for empty transcripts
                if (this.streamingCapture) {
                  this.streamingCapture.setTranscribing(false);
                }
                return;
              }
              
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
            this.log(`Failed to parse JSON from transcript service: ${text.substring(0,50)}`, LogLevel.ERROR);
          }
          
          this.currentTranscript = '';
          this.callbacks.onTranscriptUpdate(this.transcripts, this.currentTranscript);
          
          // Transcription complete - resume audio streaming and flush buffer
          if (this.streamingCapture) {
            this.streamingCapture.setTranscribing(false);
          }
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
            } else {
              // JSON parsed but no 'reply' field - show the whole thing
              this.log(`JSON missing 'reply' field. Showing raw response.`, LogLevel.WARN);
              this.replies.push({
                timestamp: new Date().toLocaleTimeString(),
                text: text
              });
            }
          } catch (e) {
            // JSON parsing failed - show the raw response as fallback
            this.log(`Failed to parse JSON from reply service. Showing raw response.`, LogLevel.WARN);
            this.replies.push({
              timestamp: new Date().toLocaleTimeString(),
              text: text
            });
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

      // CRITICAL: Add delay and validate connections are still active
      // This prevents race conditions where services disconnect immediately after connecting
      this.log('Waiting for services to stabilize...', LogLevel.INFO);
      await new Promise(resolve => setTimeout(resolve, 500));

      // Validate both services are still connected after delay
      if (!service1.isConnected() || !service2.isConnected()) {
        const disconnected = [];
        if (!service1.isConnected()) disconnected.push('transcript');
        if (!service2.isConnected()) disconnected.push('reply');

        this.log(`Services disconnected during initialization: ${disconnected.join(', ')}. Waiting for reconnection...`, LogLevel.WARN);

        // Wait up to 5 seconds for reconnection
        for (let i = 0; i < 10; i++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          if (service1.isConnected() && service2.isConnected()) {
            this.log('Both services reconnected successfully!', LogLevel.SUCCESS);
            break;
          }
        }

        // Final check
        if (!service1.isConnected() || !service2.isConnected()) {
          const stillDisconnected = [];
          if (!service1.isConnected()) stillDisconnected.push('transcript');
          if (!service2.isConnected()) stillDisconnected.push('reply');
          throw new Error(`Failed to establish stable connection. Services still disconnected: ${stillDisconnected.join(', ')}`);
        }
      }

      this.log('Services are stable. Starting audio streaming...', LogLevel.SUCCESS);

      // Set up audio streaming
      this.setupAudioStreaming();

    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      this.log(`Failed to start session: ${message}`, LogLevel.ERROR);
      this.callbacks.onError(`Failed to start session: ${message}`);
      this.callbacks.onStatusChange(AppStatus.ERROR);
      this.cleanup();
    }
  }

  private setupAudioStreaming(): void {
    // Prevent duplicate initialization
    if (this.streamingInitialized) {
      this.log('Streaming already initialized, skipping duplicate setup', LogLevel.WARN);
      return;
    }

    if (!this.mediaStream) {
      this.log('Cannot setup audio streaming: missing mediaStream', LogLevel.ERROR);
      return;
    }

    if (!this.transcriptService || !this.replyService) {
      this.log('Cannot setup audio streaming: services not ready', LogLevel.ERROR);
      return;
    }

    // Double-check services are actually connected
    if (!this.transcriptService.isConnected() || !this.replyService.isConnected()) {
      this.log('Cannot setup audio streaming: services not connected', LogLevel.ERROR);
      return;
    }

    this.log('Initializing continuous audio streaming...', LogLevel.SUCCESS);

    try {
      const capture = new ContinuousStreamingCapture(
        STREAMING_CONFIG,
        {
          onError: (error) => {
            this.callbacks.onError(`Streaming Error: ${error}`);
            this.callbacks.onStatusChange(AppStatus.ERROR);
          },
          onStatusChange: (newStatus) => this.callbacks.onStatusChange(newStatus),
        },
        this.log
      );

      // Set both services and the media stream
      capture.setApiServices({
        transcriptService: this.transcriptService,
        replyService: this.replyService
      });
      capture.setMediaStream(this.mediaStream);
      this.streamingCapture = capture;

      capture.start();
      this.streamingInitialized = true;
      this.log('Continuous audio streaming started!', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Failed to start audio streaming: ${message}`, LogLevel.ERROR);
      this.callbacks.onError(`Failed to start audio streaming: ${message}`);
      throw error;
    }
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
    this.streamingInitialized = false;
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
    
    this.streamingInitialized = false;
  }

  public getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }
}
