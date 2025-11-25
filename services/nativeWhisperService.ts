import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

interface WhisperCallbacks {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (error: string) => void;
}

interface WhisperConfig {
  modelSize?: 'tiny' | 'base' | 'small';
  language?: string;
  temperature?: number;
}

/**
 * Native Whisper Service for local transcription in Electron
 * Uses whisper-node via IPC to provide fast, local speech-to-text with no API costs
 */
class NativeWhisperService {
  private isInitialized = false;
  private log: LogFunction;
  private config: WhisperConfig;
  private isProcessing = false;

  constructor(log: LogFunction, config: WhisperConfig = {}) {
    this.log = log;
    this.config = {
      modelSize: config.modelSize || 'tiny',
      language: config.language || 'en',
      temperature: config.temperature || 0.0,
    };
  }

  /**
   * Initialize the Whisper model via IPC
   * Downloads model if not present (~75MB for tiny, ~145MB for base)
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.log('Whisper already initialized', LogLevel.INFO);
      return;
    }

    try {
      this.log(`Initializing Whisper ${this.config.modelSize} model...`, LogLevel.INFO);
      
      // Check if running in Electron
      if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Whisper service requires Electron environment');
      }

      // Initialize via IPC (runs in main process)
      const modelName = `${this.config.modelSize}.en`;
      const result = await window.electronAPI.whisperInitialize(modelName);
      
      if (!result.success) {
        throw new Error(result.error || 'Unknown initialization error');
      }

      this.isInitialized = true;
      this.log(`Whisper ${this.config.modelSize} model initialized`, LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Failed to initialize Whisper: ${message}`, LogLevel.ERROR);
      throw new Error(`Whisper initialization failed: ${message}`);
    }
  }

  /**
   * Transcribe audio buffer (3-second chunks recommended)
   * @param audioBuffer - PCM16 audio buffer (16kHz, mono, 16-bit) as Uint8Array or Buffer
   * @returns Transcribed text
   */
  async transcribe(audioBuffer: Uint8Array | ArrayBuffer): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Whisper not initialized. Call initialize() first.');
    }

    if (this.isProcessing) {
      this.log('Previous transcription still processing, skipping...', LogLevel.WARN);
      return '';
    }

    try {
      this.isProcessing = true;
      const startTime = Date.now();

      // Check if running in Electron
      if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Whisper service requires Electron environment');
      }

      // Convert to array for IPC transfer
      const audioArray = audioBuffer instanceof ArrayBuffer 
        ? Array.from(new Uint8Array(audioBuffer))
        : Array.from(audioBuffer);

      // Transcribe via IPC (runs in main process)
      const result = await window.electronAPI.whisperTranscribe(audioArray, {
        language: this.config.language,
        task: 'transcribe',
        maxLen: 1,
        splitOnWord: true,
      });

      if (!result.success) {
        throw new Error(result.error || 'Transcription failed');
      }

      const processingTime = Date.now() - startTime;
      const audioLengthBytes = audioBuffer instanceof ArrayBuffer ? audioBuffer.byteLength : audioBuffer.length;
      const audioLength = audioLengthBytes / (16000 * 2); // 16kHz, 16-bit = 2 bytes per sample
      
      this.log(
        `Transcribed ${audioLength.toFixed(1)}s audio in ${processingTime}ms: "${result.text || ''}"`,
        LogLevel.SUCCESS
      );

      this.isProcessing = false;
      return result.text?.trim() || '';
    } catch (error) {
      this.isProcessing = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Transcription error: ${message}`, LogLevel.ERROR);
      throw error;
    }
  }

  /**
   * Process audio stream with callbacks for real-time updates
   * @param audioChunks - Array of audio chunks (each 3 seconds)
   * @param callbacks - Callbacks for transcript and error handling
   */
  async processAudioStream(
    audioChunks: Buffer[],
    callbacks: WhisperCallbacks
  ): Promise<void> {
    for (const chunk of audioChunks) {
      try {
        const transcript = await this.transcribe(chunk);
        if (transcript) {
          callbacks.onTranscript(transcript, true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        callbacks.onError(message);
      }
    }
  }

  /**
   * Check if Whisper is ready
   */
  isReady(): boolean {
    return this.isInitialized && !this.isProcessing;
  }

  /**
   * Cleanup resources via IPC
   */
  async dispose(): Promise<void> {
    if (typeof window !== 'undefined' && window.electronAPI) {
      await window.electronAPI.whisperDispose();
    }
    this.isInitialized = false;
    this.isProcessing = false;
    this.log('Whisper service disposed', LogLevel.INFO);
  }
}

export default NativeWhisperService;
