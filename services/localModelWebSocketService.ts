import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

interface LocalModelCallbacks {
  onTranscript?: (text: string, isFinal: boolean) => void;
  onSummaryStart?: () => void;
  onSummaryChunk?: (text: string) => void;
  onSummaryComplete?: (fullText: string) => void;
  onDownloadProgress?: (model: string, percent: number) => void;
  onError: (error: string) => void;
  onClose?: (reason: string) => void;
  onReconnecting?: () => void;
}

/**
 * WebSocket client for communicating with Python model server
 * Handles both Parakeet transcription and Gemma summarization
 */
class LocalModelWebSocketService {
  private ws: WebSocket | null = null;
  private log: LogFunction;
  private callbacks: LocalModelCallbacks | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: number | null = null;
  private isIntentionallyClosing = false;
  private chunkIdCounter = 0;
  private pendingTranscripts: Map<number, (text: string) => void> = new Map();

  constructor(log: LogFunction) {
    this.log = log;
  }

  /**
   * Connect to Python WebSocket server
   */
  async connect(callbacks: LocalModelCallbacks): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.log('[LocalModel] Already connected', LogLevel.WARN);
      return;
    }

    this.callbacks = callbacks;
    this.isIntentionallyClosing = false;
    this.reconnectAttempts = 0;

    return this.connectInternal();
  }

  private async connectInternal(): Promise<void> {
    try {
      // Get WebSocket URL from Electron main process
      if (!window.electronAPI) {
        throw new Error('Electron API not available');
      }
      
      // @ts-ignore - pythonGetServerUrl exists but TypeScript cache may not recognize it yet
      const serverUrl = await window.electronAPI.pythonGetServerUrl();
      
      if (!serverUrl) {
        throw new Error('Python server not ready');
      }

      this.log(`[LocalModel] Connecting to ${serverUrl}`, LogLevel.INFO);

      this.ws = new WebSocket(serverUrl);

      this.ws.onopen = () => {
        this.log('[LocalModel] ✅ WebSocket connected', LogLevel.SUCCESS);
        this.reconnectAttempts = 0;
        
        // Send ping to verify connection
        this.send({ type: 'ping' });
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          this.log(`[LocalModel] Failed to parse message: ${error}`, LogLevel.ERROR);
        }
      };

      this.ws.onerror = (error) => {
        this.log(`[LocalModel] WebSocket error: ${error}`, LogLevel.ERROR);
        this.callbacks?.onError('WebSocket connection error');
      };

      this.ws.onclose = (event) => {
        this.log(`[LocalModel] WebSocket closed: ${event.code} ${event.reason}`, LogLevel.WARN);
        this.ws = null;

        if (!this.isIntentionallyClosing) {
          this.callbacks?.onClose?.(event.reason || 'Connection closed');
          this.attemptReconnect();
        }
      };

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);

        if (this.ws) {
          this.ws.addEventListener('open', () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });

          this.ws.addEventListener('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          }, { once: true });
        }
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.log(`[LocalModel] Connection failed: ${message}`, LogLevel.ERROR);
      throw error;
    }
  }

  private handleMessage(message: any): void {
    const { type } = message;

    switch (type) {
      case 'pong':
        // Connection alive
        break;

      case 'transcript':
        const { text, chunk_id, is_final } = message;
        
        // Resolve pending promise if exists
        const resolver = this.pendingTranscripts.get(chunk_id);
        if (resolver) {
          resolver(text);
          this.pendingTranscripts.delete(chunk_id);
        }
        
        // Call callback
        this.callbacks?.onTranscript?.(text, is_final);
        break;

      case 'summary_start':
        this.callbacks?.onSummaryStart?.();
        break;

      case 'summary_chunk':
        this.callbacks?.onSummaryChunk?.(message.text);
        break;

      case 'summary_complete':
        this.callbacks?.onSummaryComplete?.(message.full_text);
        break;

      case 'error':
        this.log(`[LocalModel] Server error: ${message.message}`, LogLevel.ERROR);
        this.callbacks?.onError(message.message);
        break;

      default:
        this.log(`[LocalModel] Unknown message type: ${type}`, LogLevel.WARN);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('[LocalModel] Max reconnection attempts reached', LogLevel.ERROR);
      this.callbacks?.onError('Failed to reconnect to Python server');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);

    this.log(`[LocalModel] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`, LogLevel.INFO);
    this.callbacks?.onReconnecting?.();

    this.reconnectTimeout = window.setTimeout(() => {
      this.connectInternal().catch((error) => {
        this.log(`[LocalModel] Reconnection failed: ${error}`, LogLevel.ERROR);
      });
    }, delay);
  }

  /**
   * Send audio for transcription (8-second chunks of PCM16 at 16kHz)
   */
  async transcribeAudio(audioBase64: string): Promise<string> {
    if (!this.isConnected()) {
      throw new Error('Not connected to Python server');
    }

    const chunkId = this.chunkIdCounter++;

    // Create promise for response
    const transcriptPromise = new Promise<string>((resolve, reject) => {
      this.pendingTranscripts.set(chunkId, resolve);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingTranscripts.has(chunkId)) {
          this.pendingTranscripts.delete(chunkId);
          reject(new Error('Transcription timeout'));
        }
      }, 30000);
    });

    // Send request
    this.send({
      type: 'transcribe',
      audio: audioBase64,
      chunk_id: chunkId
    });

    return transcriptPromise;
  }

  /**
   * Send transcript + images for summarization
   */
  async generateSummary(
    transcripts: string[],
    imagesBase64: string[],
    systemPrompt: string,
    userPrompt?: string
  ): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Not connected to Python server');
    }

    this.send({
      type: 'summarize',
      transcripts: transcripts,
      images: imagesBase64,
      system_prompt: systemPrompt,
      user_prompt: userPrompt
    });
  }

  private send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      this.log('[LocalModel] Cannot send - not connected', LogLevel.ERROR);
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    this.isIntentionallyClosing = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.pendingTranscripts.clear();
    this.callbacks = null;

    this.log('[LocalModel] Disconnected', LogLevel.INFO);
  }
}

export default LocalModelWebSocketService;
