import { LogLevel } from '../types';

type LogFunction = (message: string, level?: LogLevel) => void;

type ParakeetStatus =
  | { type: 'status'; state: 'loading_model' | 'ready' | 'error'; detail?: string }
  | { type: 'stream_started'; stream_id: string }
  | { type: 'partial'; stream_id: string; text: string; t_ms?: number }
  | { type: 'stream_stopped' }
  | { type: 'stream_reset'; stream_id: string }
  | { type: 'error'; stream_id?: string; message: string }
  | { type: 'pong'; t?: number };

export interface ParakeetBatchTranscriptSegment {
  start: number;
  end: number;
  text: string;
  is_final: boolean;
}

interface ParakeetBatchTranscriberCallbacks {
  onReady?: () => void;
  onError?: (message: string) => void;
}

/**
 * Batch-only Parakeet transcriber used by UploadQueueManager.
 *
 * Important: timestamps are normalized to "seconds-from-start of the audio/video" so they align
 * with 1 FPS frames (`timestamp_ms = seconds * 1000`) and Qwen window overlap filtering.
 */
export default class ParakeetBatchTranscriber {
  private ws: WebSocket | null = null;
  private callbacks: ParakeetBatchTranscriberCallbacks | null = null;
  private log: LogFunction;
  private isConnecting = false;

  constructor(log: LogFunction) {
    this.log = log;
  }

  public async connect(callbacks: ParakeetBatchTranscriberCallbacks): Promise<void> {
    this.callbacks = callbacks;
    const host = (import.meta as any).env?.VITE_PARAKEET_WS_HOST || '127.0.0.1';
    const port = (import.meta as any).env?.VITE_PARAKEET_WS_PORT || '8765';
    const url = `ws://${host}:${port}`;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.isConnecting) return;
    this.isConnecting = true;

    // Parakeet model load can take 1–3+ minutes on first run; keep retrying longer by default.
    const connectTimeoutMs = Number((import.meta as any).env?.VITE_PARAKEET_CONNECT_TIMEOUT_MS || 180000);
    const attemptTimeoutMs = Number((import.meta as any).env?.VITE_PARAKEET_CONNECT_ATTEMPT_TIMEOUT_MS || 2000);
    const startedAt = Date.now();

    try {
      while (Date.now() - startedAt < connectTimeoutMs) {
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            let timeoutId: number | null = null;

            try {
              this.ws = new WebSocket(url);
              this.ws.binaryType = 'arraybuffer';
            } catch (e) {
              reject(e);
              return;
            }

            const ws = this.ws;

            const cleanup = () => {
              if (timeoutId) window.clearTimeout(timeoutId);
              ws.onopen = null;
              ws.onmessage = null;
              ws.onerror = null;
              ws.onclose = null;
            };

            const fail = (err: Error) => {
              if (settled) return;
              settled = true;
              cleanup();
              try {
                ws.close();
              } catch {
                // ignore
              }
              reject(err);
            };

            ws.onopen = () => {
              if (settled) return;
              settled = true;
              cleanup();
              this.log(`[Parakeet Batch] Connected to ${url}`, LogLevel.SUCCESS);
              ws.send(JSON.stringify({ type: 'hello', client: 'batch', version: 1 }));
              ws.onmessage = (evt) => this.handleMessage(evt.data);
              ws.onclose = () => {
                this.log('[Parakeet Batch] Disconnected', LogLevel.WARN);
              };
              resolve();
            };

            ws.onerror = () => {
              fail(new Error('WebSocket error'));
            };

            ws.onclose = () => {
              fail(new Error('WebSocket closed'));
            };

            timeoutId = window.setTimeout(() => {
              fail(new Error('Parakeet worker not reachable'));
            }, attemptTimeoutMs);
          });

          return;
        } catch {
          // Backoff and retry until overall timeout.
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const msg = `[Parakeet Batch] Parakeet worker not reachable at ${url}`;
      this.log(msg, LogLevel.ERROR);
      this.callbacks?.onError?.(msg);
      throw new Error('Parakeet worker not reachable');
    } finally {
      this.isConnecting = false;
    }
  }

  public disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
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
      case 'error':
        this.callbacks?.onError?.(msg.message);
        break;
      default:
        break;
    }
  }

  public async transcribeVideoToFile(
    videoFile: File,
    outputPath: string,
    onProgress?: (segmentCount: number) => void,
    options: { segmentSeconds?: number } = {}
  ): Promise<void> {
    const segmentSeconds = Math.max(1, options.segmentSeconds ?? 5);

    const host = (import.meta as any).env?.VITE_PARAKEET_WS_HOST || '127.0.0.1';
    const port = (import.meta as any).env?.VITE_PARAKEET_WS_PORT || '8765';
    const url = `ws://${host}:${port}`;

    this.log('[Parakeet Batch] Starting video transcription...', LogLevel.INFO);

    if (!window.electronAPI || !window.electronAPI.getUserDataPath || !window.electronAPI.writeBinary) {
      throw new Error('Electron API not available');
    }

    const userDataPath = await window.electronAPI.getUserDataPath();
    const tempVideoPath = `${userDataPath}/temp_video_${Date.now()}.mp4`;

    this.log('[Parakeet Batch] Saving video to temp file...', LogLevel.INFO);
    const arrayBuffer = await videoFile.arrayBuffer();
    const videoBase64 = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
    const saveResult = await window.electronAPI.writeBinary(tempVideoPath, videoBase64);
    if (!saveResult) {
      throw new Error('Failed to save video to temp file');
    }

    this.log('[Parakeet Batch] Extracting audio with ffmpeg...', LogLevel.INFO);
    const audioResult = await window.electronAPI.extractAudioFromVideo(tempVideoPath);
    if (!audioResult.success || !audioResult.audioPath) {
      throw new Error(`Audio extraction failed: ${audioResult.error || 'Unknown error'}`);
    }

    this.log(
      `[Parakeet Batch] Audio extracted: ${(audioResult.size! / 1024 / 1024).toFixed(2)}MB`,
      LogLevel.SUCCESS
    );

    const audioBase64 = await window.electronAPI.readBinary(audioResult.audioPath);
    const audioBinary = atob(audioBase64);
    const audioBytes = new Uint8Array(audioBinary.length);
    for (let i = 0; i < audioBinary.length; i++) audioBytes[i] = audioBinary.charCodeAt(i);

    const pcmInt16 = new Int16Array(audioBytes.buffer, audioBytes.byteOffset, audioBytes.byteLength / 2);
    const totalDurationSeconds = pcmInt16.length / 16000;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const segments: ParakeetBatchTranscriptSegment[] = [];
    let streamId: string | null = null;
    let offsetSamples = 0;
    let lastEmitSec = 0;
    let lastSnapshotText = '';
    let latestFullText = '';

    const maybeEmitSegment = (currentSec: number) => {
      const fullText = extractBatchTranscriptText(latestFullText);
      if (!fullText) return;
      if (currentSec - lastEmitSec < segmentSeconds) return;

      const delta = extractDeltaText(lastSnapshotText, fullText).trim();
      if (!delta) return;

      segments.push({ start: lastEmitSec, end: currentSec, text: delta, is_final: true });
      lastEmitSec = currentSec;
      lastSnapshotText = fullText;
      onProgress?.(segments.length);
    };

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        this.log('[Parakeet Batch] Connected', LogLevel.SUCCESS);
        ws.send(JSON.stringify({ type: 'hello', client: 'batch', version: 1 }));
      };

      ws.onmessage = (evt) => {
        if (typeof evt.data !== 'string') return;

        let msg: ParakeetStatus | null = null;
        try {
          msg = JSON.parse(evt.data) as ParakeetStatus;
        } catch {
          return;
        }
        if (!msg) return;

        switch (msg.type) {
          case 'status':
            if (msg.state === 'ready') {
              ws.send(
                JSON.stringify({
                  type: 'start_stream',
                  sample_rate: 16000,
                  format: 'pcm_s16le',
                  channels: 1,
                })
              );
            }
            break;

          case 'stream_started':
            streamId = msg.stream_id;
            ws.send(JSON.stringify({ type: 'audio_begin', stream_id: streamId }));

            // Send audio in chunks (100ms per chunk = 1600 samples @ 16kHz).
            const chunkSize = 1600;

            const sendNextChunk = () => {
              if (offsetSamples >= pcmInt16.length) {
                ws.send(JSON.stringify({ type: 'stop_stream', stream_id: streamId }));
                return;
              }

              const chunk = pcmInt16.slice(offsetSamples, offsetSamples + chunkSize);
              ws.send(chunk.buffer);
              offsetSamples += chunkSize;

              setTimeout(sendNextChunk, 10);
            };

            sendNextChunk();
            break;

          case 'partial':
            {
              const text = extractBatchTranscriptText(msg.text);
              if (text) {
                latestFullText = text;
                maybeEmitSegment(offsetSamples / 16000);
              }
            }
            break;

          case 'stream_stopped':
            ws.close();
            break;

          case 'error':
            ws.close();
            reject(new Error(msg.message));
            break;
        }
      };

      ws.onclose = async () => {
        // Cleanup temp files
        try {
          await window.electronAPI.deleteFile(tempVideoPath);
          await window.electronAPI.deleteFile(audioResult.audioPath!);
        } catch (err) {
          this.log(`[Parakeet Batch] Cleanup warning: ${err}`, LogLevel.WARN);
        }

        // Final flush to duration.
        const finalFull = extractBatchTranscriptText(latestFullText);
        if (finalFull) {
          const delta = extractDeltaText(lastSnapshotText, finalFull).trim();
          if (delta) {
            segments.push({
              start: lastEmitSec,
              end: totalDurationSeconds,
              text: delta,
              is_final: true,
            });
          }
        }

        try {
          const success = await window.electronAPI.writeFile(outputPath, JSON.stringify(segments, null, 2));
          if (success) {
            this.log(`[Parakeet Batch] Transcripts saved: ${segments.length} segment(s)`, LogLevel.SUCCESS);
            resolve();
          } else {
            reject(new Error('Failed to write transcript file'));
          }
        } catch (error) {
          reject(new Error(`Failed to save transcripts: ${error}`));
        }
      };

      ws.onerror = () => reject(new Error('Parakeet worker connection failed'));
    });
  }
}

function extractDeltaText(previousFullText: string, currentFullText: string): string {
  if (!currentFullText) return '';
  if (!previousFullText) return currentFullText;

  if (currentFullText.startsWith(previousFullText)) {
    return currentFullText.slice(previousFullText.length);
  }

  const prevWords = previousFullText.trim().split(/\s+/);
  const anchorWords = prevWords.slice(Math.max(0, prevWords.length - 12));
  const anchor = anchorWords.join(' ').trim();
  if (anchor.length >= 8) {
    const idx = currentFullText.indexOf(anchor);
    if (idx >= 0) {
      return currentFullText.slice(idx + anchor.length);
    }
  }

  const max = Math.min(previousFullText.length, currentFullText.length);
  let i = 0;
  for (; i < max; i++) {
    if (previousFullText.charCodeAt(i) !== currentFullText.charCodeAt(i)) break;
  }
  const boundary = currentFullText.slice(0, i).lastIndexOf(' ');
  if (boundary > 0) return currentFullText.slice(boundary + 1);

  return currentFullText;
}

function extractBatchTranscriptText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';

  if (text.startsWith('Hypothesis(')) {
    const match = text.match(/\btext='([^']*)'/);
    const inner = match?.[1]?.trim() ?? '';
    if (!inner) return '';
    return inner;
  }

  if (text.includes('y_sequence=') || text.includes('tensor(') || text.includes('dec_state=')) {
    return '';
  }

  return text;
}
