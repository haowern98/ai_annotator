import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

interface TranscriptWord {
  word: string;
  start_ms: number;
  end_ms: number;
}

interface ParakeetResponse {
  text: string;
  words: TranscriptWord[];
  is_final: boolean;
  error?: string;
}

interface ParakeetCallbacks {
  onTranscript: (text: string, isFinal: boolean, words?: TranscriptWord[]) => void;
  onError: (error: string) => void;
  onClose?: (reason: string) => void;
}

/**
 * Parakeet Transcription Service for local transcription via WebSocket
 * Uses NVIDIA Parakeet-TDT-0.6B-v3 with NeMo + CUDA
 * Connects to Python WebSocket server at ws://localhost:8765
 */
class ParakeetTranscriptionService {
  private ws: WebSocket | null = null;
  private isInitialized = false;
  private log: LogFunction;
  private callbacks: ParakeetCallbacks | null = null;
  private isProcessing = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectTimeoutId: number | null = null;

  constructor(log: LogFunction) {
    this.log = log;
  }

  /**
   * Initialize Parakeet server and establish WebSocket connection
   */
  async initialize(callbacks: ParakeetCallbacks): Promise<void> {
    if (this.isInitialized) {
      this.log('[Parakeet] Already initialized', LogLevel.INFO);
      return;
    }

    try {
      this.log('[Parakeet] Initializing Parakeet transcription service...', LogLevel.INFO);
      this.callbacks = callbacks;

      // Check if running in Electron
      if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Parakeet service requires Electron environment');
      }

      // Server is already started by splash screen on app launch
      // Just check if it's healthy
      this.log('[Parakeet] Checking server health...', LogLevel.INFO);
      const health = await window.electronAPI.parakeetHealth();

      if (!health.healthy) {
        throw new Error('Parakeet server is not healthy. Please restart the application.');
      }

      this.log('[Parakeet] Server is healthy, connecting WebSocket...', LogLevel.INFO);

      // Connect to already-running server
      await this.connectWebSocket();

      this.isInitialized = true;
      this.log('[Parakeet] ✓ Service initialized successfully', LogLevel.SUCCESS);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[Parakeet] ❌ Initialization failed: ${message}`, LogLevel.ERROR);
      throw new Error(`Parakeet initialization failed: ${message}`);
    }
  }

  /**
   * Connect to WebSocket server with retry logic
   */
  private async connectWebSocket(): Promise<void> {
    const wsUrl = 'ws://localhost:8765/transcribe';
    const maxRetries = 5;
    const retryDelay = 1000; // 1 second

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.log(`[Parakeet] Connecting to WebSocket (attempt ${attempt}/${maxRetries})...`, LogLevel.INFO);

        await new Promise<void>((resolve, reject) => {
          this.ws = new WebSocket(wsUrl);

          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
          }, 5000);

          this.ws.onopen = () => {
            clearTimeout(timeout);
            this.log('[Parakeet] ✓ WebSocket connected', LogLevel.SUCCESS);
            this.reconnectAttempts = 0;
            resolve();
          };

          this.ws.onerror = (event) => {
            clearTimeout(timeout);
            reject(new Error('WebSocket connection failed'));
          };

          this.ws.onclose = (event) => {
            clearTimeout(timeout);
            this.log(`[Parakeet] WebSocket closed: ${event.reason || 'Unknown reason'}`, LogLevel.WARN);
            this.handleDisconnection();
          };

          this.ws.onmessage = (event) => {
            this.handleMessage(event.data);
          };
        });

        return; // Success
      } catch (error) {
        this.log(`[Parakeet] Connection attempt ${attempt} failed`, LogLevel.WARN);

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          throw new Error(`Failed to connect after ${maxRetries} attempts`);
        }
      }
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const response: ParakeetResponse = JSON.parse(data);

      if (response.error) {
        this.log(`[Parakeet] Server error: ${response.error}`, LogLevel.ERROR);
        this.callbacks?.onError(response.error);
        return;
      }

      if (response.text && response.text.trim()) {
        this.log(`[Parakeet] ✓ Received: "${response.text.substring(0, 80)}..."`, LogLevel.SUCCESS);
        this.callbacks?.onTranscript(response.text, response.is_final, response.words);
      }

      this.isProcessing = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[Parakeet] Message parse error: ${message}`, LogLevel.ERROR);
      this.callbacks?.onError(message);
    }
  }

  /**
   * Handle WebSocket disconnection
   */
  private handleDisconnection(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts && this.isInitialized) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);

      this.log(`[Parakeet] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`, LogLevel.WARN);

      this.reconnectTimeoutId = window.setTimeout(async () => {
        try {
          await this.connectWebSocket();
        } catch (error) {
          this.log('[Parakeet] Reconnection failed', LogLevel.ERROR);
          this.callbacks?.onClose?.('Reconnection failed');
        }
      }, delay);
    } else {
      this.callbacks?.onClose?.('Connection lost');
    }
  }

  /**
   * Send audio data for transcription (base64 PCM16)
   * @param audioBase64 - Base64-encoded PCM16 audio data
   * @param mimeType - MIME type (default: audio/pcm;rate=16000)
   */
  async sendAudio(audioBase64: string, mimeType: string = 'audio/pcm;rate=16000'): Promise<void> {
    if (!this.isInitialized || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('[Parakeet] Cannot send audio: not connected', LogLevel.WARN);
      return;
    }

    try {
      const message = {
        audio: audioBase64,
        mimeType: mimeType
      };

      this.ws.send(JSON.stringify(message));
      this.isProcessing = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[Parakeet] Send error: ${message}`, LogLevel.ERROR);
      this.callbacks?.onError(message);
    }
  }

  /**
   * Check if service is connected and ready
   */
  isConnected(): boolean {
    return this.isInitialized && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Check if currently processing transcription
   */
  isReady(): boolean {
    return this.isConnected() && !this.isProcessing;
  }

  /**
   * Cleanup resources and stop Python server
   */
  async dispose(): Promise<void> {
    this.log('[Parakeet] Disposing service...', LogLevel.INFO);

    // Clear reconnection timer
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // NOTE: Do NOT stop Python server - it should stay running for the app's lifetime
    // The server is started once at app launch via splash screen
    // and only stopped when the app closes

    this.isInitialized = false;
    this.isProcessing = false;
    this.callbacks = null;
    this.reconnectAttempts = 0;

    this.log('[Parakeet] ✓ Service disposed (server still running)', LogLevel.SUCCESS);
  }
}

export default ParakeetTranscriptionService;
export type { TranscriptWord, ParakeetCallbacks };
