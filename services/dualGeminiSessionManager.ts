import React from 'react';
import { AppStatus, LogLevel, InterviewContext } from '../types';
import LiveApiService from './liveApiService';
import { ContinuousStreamingCapture } from '../utils/continuousStreaming';
import { captureScreen, isElectron } from '../utils/screenCapture';

// Configuration for the two Gemini sessions:
// 1. Transcript Service: Uses inputAudioTranscription for real-time speech-to-text
// 2. Reply Service: Generates AI responses to interviewer questions

const buildReplyPrompt = (context?: InterviewContext): string => {
  // Build context sections only for non-empty fields
  const sections: string[] = [];
  
  // Candidate info
  const name = context?.name || 'a candidate';
  const role = context?.role || 'a software engineer position';
  const company = context?.company || 'a software engineering company';
  
  sections.push(`You are helping ${name} who is interviewing for ${role} at ${company}.`);
  
  // Resume (only if provided)
  if (context?.resume?.trim()) {
    sections.push(`## Candidate Background\n${context.resume.trim()}`);
  }
  
  // Job Description (only if provided)
  if (context?.jobDescription?.trim()) {
    sections.push(`## Job Description\n${context.jobDescription.trim()}`);
  }
  
  // Additional Notes (only if provided)
  if (context?.notes?.trim()) {
    sections.push(`## Additional Notes\n${context.notes.trim()}`);
  }
  
  // Response format instruction
  sections.push(`Respond ONLY with a valid JSON object in the following format:
{
  "reply": "[Your response to the interviewer's question or statement. If the question is short, reply with a single sentence. If the question is more detailed, use the STAR framework to provide a more detailed response with examples and elaboration, but still be concise]"
}`);
  
  return sections.join('\n\n');
};

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
  private transcriptService: LiveApiService | null = null;  // Gemini for transcription
  private replyService: LiveApiService | null = null;        // Gemini for AI replies
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

  constructor(
    callbacks: DualSessionCallbacks,
    log: LogFunction
  ) {
    this.callbacks = callbacks;
    this.log = log;
  }

  public async start(
    apiKey: string,
    onSourceRequired?: (sources: any[]) => Promise<string>,
    interviewContext?: InterviewContext
  ): Promise<void> {
    this.log('Dual Session Manager: Starting with native Whisper transcription...');
    
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
    
    this.log('Initializing dual Gemini sessions (transcription + reply)...');
    this.callbacks.onStatusChange(AppStatus.CAPTURING);

    try {
      this.log(`Requesting screen capture... ${isElectron() ? '(Electron mode)' : '(Browser mode)'}`);
      const stream = await captureScreen({
        video: true,
        audio: true,
        onSourceRequired
      });
      this.mediaStream = stream;
      
      // Verify audio tracks are present
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        this.log('WARNING: No audio tracks in media stream. Audio capture may not work.', LogLevel.WARN);
      } else {
        this.log(`Audio tracks found: ${audioTracks.length} track(s)`, LogLevel.SUCCESS);
      }

      // Verify video tracks are present
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length === 0) {
        this.log('WARNING: No video tracks in media stream. Video preview may not work.', LogLevel.WARN);
      } else {
        this.log(`Video tracks found: ${videoTracks.length} track(s)`, LogLevel.SUCCESS);
      }
      
      this.callbacks.onStatusChange(AppStatus.CONNECTING);

      // Initialize Transcript Service (Gemini for speech-to-text)
      this.log('Initializing Gemini transcription service...', LogLevel.INFO);
      const transcriptService = new LiveApiService(apiKey, this.log, 'transcript');
      
      await transcriptService.connect({
        onTranscript: (text, isFinal) => {
          if (isFinal) {
            // Turn complete - add to transcript history
            this.log(`Final transcript received: "${text.substring(0, 50)}..."`, LogLevel.SUCCESS);
            this.transcripts.push({
              timestamp: new Date().toLocaleTimeString(),
              text: text.trim()
            });
            this.callbacks.onTranscriptUpdate(this.transcripts, '');
            
            // Queue for AI reply
            this.transcriptQueue.push(text);
            this.processTranscriptQueue();
          } else {
            // Streaming update - show in UI
            this.currentTranscript = text;
            this.callbacks.onTranscriptUpdate(this.transcripts, text);
          }
        },
        onModelResponse: () => {}, // Not used for transcript service
        onError: (e) => {
          this.callbacks.onError(`Transcription Service Error: ${e}`);
          this.callbacks.onStatusChange(AppStatus.ERROR);
          this.cleanup();
        },
        onClose: () => this.log('Transcription service closed.'),
      }, 'You are a transcription service. Your only job is to transcribe audio accurately.');
      
      this.transcriptService = transcriptService;
      this.log('Gemini transcription service connected', LogLevel.SUCCESS);

      // Connect Reply Service (Gemini for AI responses)
      const replyService = new LiveApiService(apiKey, this.log, 'reply');
      
      await replyService.connect({
        onTranscript: () => {},  // Not used - Whisper handles transcription
        onModelTurnStart: () => {
          this.isReplyGenerating = true;
          this.log('Reply generation started', LogLevel.INFO);
        },
        onPartialResponse: (textChunk) => {
          this.currentReply = this.currentReply === '' ? '...' : this.currentReply;
          this.callbacks.onReplyUpdate(this.replies, this.currentReply);
        },
        onModelResponse: (text) => {
          try {
            const cleanText = text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(cleanText);

            if (parsed.reply) {
              const replyText = parsed.reply;
              this.replies.push({
                timestamp: new Date().toLocaleTimeString(),
                text: replyText
              });
              this.log(`Parsed reply: ${replyText.substring(0,30)}...`, LogLevel.SUCCESS);
            } else {
              this.log(`JSON missing 'reply' field. Showing raw response.`, LogLevel.WARN);
              this.replies.push({
                timestamp: new Date().toLocaleTimeString(),
                text: text
              });
            }
          } catch (e) {
            this.log(`Failed to parse JSON from reply service. Showing raw response.`, LogLevel.WARN);
            this.replies.push({
              timestamp: new Date().toLocaleTimeString(),
              text: text
            });
          }
          
          this.currentReply = '';
          this.isReplyGenerating = false;
          this.log('Reply generation complete', LogLevel.SUCCESS);
          
          this.callbacks.onReplyUpdate(this.replies, this.currentReply);
          this.processTranscriptQueue();
        },
        onError: (e) => { 
          this.callbacks.onError(`Reply Service Error: ${e}`);
          this.callbacks.onStatusChange(AppStatus.ERROR);
          this.cleanup();
        },
        onClose: () => this.log('Reply service closed.'),
      }, buildReplyPrompt(interviewContext));

      this.log('Reply service connected successfully.', LogLevel.SUCCESS);
      this.replyService = replyService;
      this.callbacks.onStatusChange(AppStatus.ANALYZING);

      // Wait for service to stabilize
      this.log('Waiting for service to stabilize...', LogLevel.INFO);
      await new Promise(resolve => setTimeout(resolve, 500));

      if (!replyService.isConnected()) {
        throw new Error('Failed to establish stable connection to reply service');
      }

      this.log('Service is stable. Starting continuous audio/video streaming...', LogLevel.SUCCESS);

      // Set up continuous streaming to Gemini
      this.setupContinuousStreaming();

    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      this.log(`Failed to start session: ${message}`, LogLevel.ERROR);
      this.callbacks.onError(`Failed to start session: ${message}`);
      this.callbacks.onStatusChange(AppStatus.ERROR);
      this.cleanup();
    }
  }

  private async setupContinuousStreaming(): Promise<void> {
    if (!this.mediaStream) {
      this.log('Cannot setup streaming: missing mediaStream', LogLevel.ERROR);
      return;
    }

    if (!this.transcriptService) {
      this.log('Cannot setup streaming: transcription service not ready', LogLevel.ERROR);
      return;
    }

    this.log('Initializing continuous A/V streaming to Gemini...', LogLevel.SUCCESS);

    try {
      // Initialize continuous streaming capture
      this.streamingCapture = new ContinuousStreamingCapture(
        {
          audioChunkMs: 100, // Send audio every 100ms for low latency
        },
        {
          onError: (error: string) => {
            this.log(`Streaming error: ${error}`, LogLevel.ERROR);
            this.callbacks.onError(error);
          },
          onStatusChange: (status: AppStatus) => {
            this.callbacks.onStatusChange(status);
          },
        },
        this.log
      );

      // Set the media stream and API services
      this.streamingCapture.setMediaStream(this.mediaStream);
      this.streamingCapture.setApiServices({
        transcriptService: this.transcriptService,
        replyService: this.replyService!,
      });

      // Start streaming
      await this.streamingCapture.start();
      this.log('Continuous A/V streaming started!', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Failed to start streaming: ${message}`, LogLevel.ERROR);
      this.callbacks.onError(`Failed to start streaming: ${message}`);
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
    this.callbacks.onStatusChange(AppStatus.IDLE);
    this.log('Analysis stopped', LogLevel.SUCCESS);
  }

  public pause(): void {
    if (this.streamingCapture) {
      this.streamingCapture.pause();
      this.log('Audio streaming paused', LogLevel.INFO);
    }
  }

  public resume(): void {
    if (this.streamingCapture) {
      this.streamingCapture.resume();
      this.log('Audio streaming resumed', LogLevel.INFO);
    }
  }

  public getIsPaused(): boolean {
    return this.streamingCapture?.getIsPaused() ?? false;
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
