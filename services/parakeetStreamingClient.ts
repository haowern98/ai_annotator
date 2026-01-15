import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

type ParakeetStatus =
  | { type: 'status'; state: 'loading_model' | 'ready' | 'error'; detail?: string }
  | { type: 'stream_started'; stream_id: string }
  | { type: 'partial'; stream_id: string; text: string; t_ms?: number }
  | { type: 'error'; stream_id?: string; message: string }
  | { type: 'pong'; t?: number };

interface ParakeetClientCallbacks {
  onReady?: () => void;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}

export default class ParakeetStreamingClient {
  private ws: WebSocket | null = null;
  private streamId: string | null = null;
  private callbacks: ParakeetClientCallbacks | null = null;
  private log: LogFunction;
  private isStarted = false;

  constructor(log: LogFunction) {
    this.log = log;
  }

  public async connect(callbacks: ParakeetClientCallbacks): Promise<void> {
    this.callbacks = callbacks;
    const host = (import.meta as any).env?.VITE_PARAKEET_WS_HOST || '127.0.0.1';
    const port = (import.meta as any).env?.VITE_PARAKEET_WS_PORT || '8765';
    const url = `ws://${host}:${port}`;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';
      } catch (e) {
        reject(e);
        return;
      }

      const ws = this.ws;

      ws.onopen = () => {
        this.log(`[Parakeet] Connected to ${url}`, LogLevel.SUCCESS);
        ws.send(JSON.stringify({ type: 'hello', client: 'app', version: 1 }));
        resolve();
      };

      ws.onmessage = (evt) => this.handleMessage(evt.data);
      ws.onerror = () => {
        const msg = `[Parakeet] WebSocket error connecting to ${url}`;
        this.log(msg, LogLevel.ERROR);
        this.callbacks?.onError?.(msg);
      };
      ws.onclose = () => {
        this.isStarted = false;
        this.streamId = null;
        this.log('[Parakeet] Disconnected', LogLevel.WARN);
      };

      // If connection doesn't open quickly, fail fast so UI can show offline.
      setTimeout(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error('Parakeet worker not reachable'));
        }
      }, 1500);
    });
  }

  public async startStream(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Parakeet not connected');
    }
    if (this.isStarted) return;
    this.isStarted = true;

    ws.send(
      JSON.stringify({
        type: 'start_stream',
        sample_rate: 16000,
        format: 'pcm_s16le',
        channels: 1,
      })
    );
  }

  public sendPcmFrame(pcm: ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this.isStarted) return;
    ws.send(pcm);
  }

  public stopStream(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.streamId) {
      ws.send(JSON.stringify({ type: 'stop_stream', stream_id: this.streamId }));
    } else {
      ws.send(JSON.stringify({ type: 'stop_stream' }));
    }
    this.isStarted = false;
    this.streamId = null;
  }

  public resetStream(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this.isStarted) return;
    ws.send(JSON.stringify({ type: 'reset_stream', stream_id: this.streamId }));
  }

  public getStreamId(): string | null {
    return this.streamId;
  }

  public disconnect(): void {
    try {
      this.stopStream();
    } catch {
      // ignore
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.streamId = null;
    this.isStarted = false;
  }

  private handleMessage(raw: any): void {
    if (typeof raw !== 'string') return;
    let msg: ParakeetStatus | null = null;
    try {
      msg = JSON.parse(raw) as ParakeetStatus;
    } catch {
      return;
    }

    if (!msg) return;

    switch (msg.type) {
      case 'status':
        if (msg.state === 'ready') this.callbacks?.onReady?.();
        break;
      case 'stream_started':
        this.streamId = msg.stream_id;
        // Tell worker that binary audio will follow (one stream per socket).
        this.ws?.send(JSON.stringify({ type: 'audio_begin', stream_id: this.streamId }));
        break;
      case 'partial':
        this.callbacks?.onPartial?.(msg.text);
        break;
      case 'error':
        this.callbacks?.onError?.(msg.message);
        break;
      default:
        break;
    }
  }
}
