import React from 'react';
import { AppStatus, LogLevel } from '../types';
import LiveApiService from './liveApiService';
import NativeWhisperService from './nativeWhisperService';
import { ContinuousStreamingCapture } from '../utils/continuousStreaming';
import { captureScreen, isElectron } from '../utils/screenCapture';
import { float32ToPCM16, resampleAudio, mergeFloat32Arrays, isSilence } from '../utils/audioConverter';

// Configuration for the two sessions

// NOTE: TRANSCRIPT_PROMPT is commented out because we now use inputAudioTranscription
// for real-time transcript accumulation. The model no longer needs to format transcripts as JSON.
// Uncomment this block if you need to revert to JSON-based transcripts.
/*
const TRANSCRIPT_PROMPT = `You are transcribing audio from an interview.

When the speaker finishes talking (turn complete), transcribe their ENTIRE statement from start to finish. Accumulate all words spoken during this complete turn.

Example:
- Speaker says: "Hello, how are you doing today? I wanted to ask about your experience."
- You respond: {"transcript": "Hello, how are you doing today? I wanted to ask about your experience."}

Do NOT respond with partial sentences or fragments. Wait for the complete turn, then provide everything.

If the turn contains no clear speech, do NOT respond.

Format: {"transcript": "[complete turn from start to finish]"}`;
*/

const REPLY_PROMPT = `You are a Malaysian who is studying at National University of Singapore who is interviewing for a software engineer position at a software engineering company.
Respond ONLY with a valid JSON object in the following format:
{
  "reply": "[Your response to the interviewer's question or statement. If the question is short, reply with a single sentence. If the question is more detailed, use the STAR framework to provide a more detailed response with examples and elaboration, but still be concise]"
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
  private whisperService: NativeWhisperService | null = null;  // NEW: Local Whisper for transcription
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
  
  // Audio buffering for native Whisper processing
  private audioChunks: Float32Array[] = [];
  private readonly CHUNK_DURATION_MS = 6000; // 6 seconds per chunk for better context
  private readonly OVERLAP_DURATION_MS = 2000; // Keep 2 seconds of overlap
  private readonly SAMPLE_RATE = 16000; // Whisper expects 16kHz
  private processingAudio: boolean = false;
  private partialTranscript: string = ''; // Accumulate within session
  private overlapBuffer: Float32Array[] = []; // Store last 2 seconds for overlap

  constructor(
    callbacks: DualSessionCallbacks,
    log: LogFunction
  ) {
    this.callbacks = callbacks;
    this.log = log;
  }

  public async start(
    apiKey: string,
    onSourceRequired?: (sources: any[]) => Promise<string>
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
    this.streamingInitialized = false;
    this.audioChunks = [];
    this.processingAudio = false;
    
    this.callbacks.onTranscriptUpdate([], '');
    this.callbacks.onReplyUpdate([], '');
    
    this.log('Initializing native Whisper + Gemini reply service...');
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

      // Initialize Native Whisper Service
      this.log('Initializing native Whisper service...', LogLevel.INFO);
      const whisperService = new NativeWhisperService(this.log, {
        modelSize: 'small',  // Fast, ~75MB model
        language: 'en',
        temperature: 0.0,
      });
      
      await whisperService.initialize();
      this.whisperService = whisperService;
      this.log('Native Whisper service initialized successfully', LogLevel.SUCCESS);

      // Connect Reply Service (Gemini for AI responses only)
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
      }, REPLY_PROMPT);

      this.log('Reply service connected successfully.', LogLevel.SUCCESS);
      this.replyService = replyService;
      this.callbacks.onStatusChange(AppStatus.ANALYZING);

      // Wait for service to stabilize
      this.log('Waiting for service to stabilize...', LogLevel.INFO);
      await new Promise(resolve => setTimeout(resolve, 500));

      if (!replyService.isConnected()) {
        throw new Error('Failed to establish stable connection to reply service');
      }

      this.log('Service is stable. Starting audio streaming...', LogLevel.SUCCESS);

      // Set up audio streaming with Whisper processing
      this.setupAudioStreamingWithWhisper();

    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error.";
      this.log(`Failed to start session: ${message}`, LogLevel.ERROR);
      this.callbacks.onError(`Failed to start session: ${message}`);
      this.callbacks.onStatusChange(AppStatus.ERROR);
      this.cleanup();
    }
  }

  private setupAudioStreamingWithWhisper(): void {
    // Prevent duplicate initialization
    if (this.streamingInitialized) {
      this.log('Streaming already initialized, skipping duplicate setup', LogLevel.WARN);
      return;
    }

    if (!this.mediaStream) {
      this.log('Cannot setup audio streaming: missing mediaStream', LogLevel.ERROR);
      return;
    }

    if (!this.whisperService) {
      this.log('Cannot setup audio streaming: Whisper service not ready', LogLevel.ERROR);
      return;
    }

    this.log('Initializing continuous audio streaming with native Whisper...', LogLevel.SUCCESS);

    try {
      const audioContext = new AudioContext({ sampleRate: this.SAMPLE_RATE });
      const source = audioContext.createMediaStreamSource(this.mediaStream);
      
      // Create ScriptProcessorNode for audio capture (will be replaced by AudioWorklet in production)
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        this.audioChunks.push(new Float32Array(inputData));
        
        // Check if we have 3 seconds of audio
        const totalSamples = this.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const durationMs = (totalSamples / this.SAMPLE_RATE) * 1000;
        
        // Log every 2 seconds
        if (Math.floor(durationMs / 2000) !== Math.floor((durationMs - 100) / 2000)) {
          this.log(`Audio buffered: ${durationMs.toFixed(0)}ms`, LogLevel.INFO);
        }
        
        if (durationMs >= this.CHUNK_DURATION_MS && !this.processingAudio) {
          this.log(`6 seconds reached, starting transcription...`, LogLevel.INFO);
          this.processAudioChunk();
        }
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      
      this.streamingInitialized = true;
      this.log('Continuous audio streaming with Whisper started!', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Failed to start audio streaming: ${message}`, LogLevel.ERROR);
      this.callbacks.onError(`Failed to start audio streaming: ${message}`);
      throw error;
    }
  }

  private async processAudioChunk(): Promise<void> {
    if (this.processingAudio || !this.whisperService || this.audioChunks.length === 0) {
      return;
    }

    this.processingAudio = true;
    this.log('Processing 6-second audio chunk with 2s overlap...', LogLevel.INFO);

    try {
      // Merge current audio chunks
      const currentAudio = mergeFloat32Arrays(this.audioChunks);
      
      // Combine with overlap from previous segment
      const audioWithOverlap = this.overlapBuffer.length > 0 
        ? mergeFloat32Arrays([...this.overlapBuffer, currentAudio])
        : currentAudio;
      
      // Check if audio is silence
      if (isSilence(audioWithOverlap, 0.01)) {
        this.log('Skipping silent audio chunk', LogLevel.INFO);
        this.audioChunks = [];
        this.processingAudio = false;
        return;
      }
      
      // Save last 2 seconds for next overlap
      const overlapSamples = (this.OVERLAP_DURATION_MS / 1000) * this.SAMPLE_RATE;
      const startOverlapIndex = Math.max(0, currentAudio.length - overlapSamples);
      this.overlapBuffer = [currentAudio.slice(startOverlapIndex)];
      
      this.log(`Audio with overlap: ${(audioWithOverlap.length / this.SAMPLE_RATE).toFixed(1)}s`, LogLevel.INFO);
      
      // Convert to PCM16 buffer
      const pcm16Buffer = float32ToPCM16(audioWithOverlap);
      
      // Transcribe using Whisper
      const transcript = await this.whisperService.transcribe(pcm16Buffer);
      
      if (transcript && transcript.trim().length > 0) {
        this.log(`Transcribed: "${transcript}"`, LogLevel.SUCCESS);
        
        // Add each new segment as a separate transcript entry (newest at top)
        this.transcripts.unshift({
          timestamp: new Date().toLocaleTimeString(),
          text: transcript.trim()
        });
        
        // Update UI with all transcript segments
        this.callbacks.onTranscriptUpdate(this.transcripts, '');
        
        // Add to queue for AI reply
        this.transcriptQueue.push(transcript);
        this.processTranscriptQueue();
      }
      
      // Clear processed audio chunks
      this.audioChunks = [];
      this.processingAudio = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error processing audio chunk: ${message}`, LogLevel.ERROR);
      this.audioChunks = [];
      this.processingAudio = false;
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
    this.audioChunks = [];
    this.processingAudio = false;
    this.callbacks.onStatusChange(AppStatus.IDLE);
    this.log('Analysis stopped', LogLevel.SUCCESS);
  }

  private cleanup(): void {
    if (this.streamingCapture) {
      this.streamingCapture.stop();
      this.streamingCapture = null;
    }
    
    this.whisperService?.dispose();
    this.replyService?.disconnect();
    this.whisperService = null;
    this.replyService = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    
    this.streamingInitialized = false;
    this.audioChunks = [];
    this.overlapBuffer = [];
    this.processingAudio = false;
  }

  public getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }
}
