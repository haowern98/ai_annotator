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

type ParakeetWordTimestamp = {
  start?: number;
  end?: number;
  [k: string]: any;
};

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
    videoFile: File | { path: string; size?: number },
    outputPath: string,
    onProgress?: (segmentCount: number) => void,
    options: { segmentSeconds?: number } = {}
  ): Promise<void> {
    const segmentSeconds = Math.max(1, options.segmentSeconds ?? 5);

    const host = (import.meta as any).env?.VITE_PARAKEET_WS_HOST || '127.0.0.1';
    const port = (import.meta as any).env?.VITE_PARAKEET_WS_PORT || '8765';
    const url = `ws://${host}:${port}`;

    this.log('[Parakeet Batch] Starting video transcription...', LogLevel.INFO);

    if (
      !window.electronAPI ||
      !window.electronAPI.getUserDataPath ||
      !window.electronAPI.writeBinary ||
      !window.electronAPI.extractAudioFromVideo ||
      !window.electronAPI.writeFile ||
      !window.electronAPI.deleteFile
    ) {
      throw new Error('Electron API not available');
    }

    const userDataPath = await window.electronAPI.getUserDataPath();
    let tempVideoPath = `${userDataPath}/temp_video_${Date.now()}.mp4`;
    let shouldCleanupVideo = true;

    this.log('[Parakeet Batch] Saving video to temp file...', LogLevel.INFO);
    if (videoFile instanceof File) {
      const arrayBuffer = await videoFile.arrayBuffer();
      const videoBase64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      const saveResult = await window.electronAPI.writeBinary(tempVideoPath, videoBase64);
      if (!saveResult) {
        throw new Error('Failed to save video to temp file');
      }
    } else {
      // Already a local path (e.g. YouTube download). Use directly to avoid loading into renderer memory.
      tempVideoPath = String(videoFile.path || '').trim();
      shouldCleanupVideo = false;
      if (!tempVideoPath) {
        throw new Error('Missing video path');
      }
    }

    const isMissingWordTimestampsError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      const normalized = msg.toLowerCase();
      return (
        normalized.includes('word timestamps not available from model output') ||
        normalized.includes('word-level timestamps not available from model output') ||
        normalized.includes('word level timestamps not available from model output')
      );
    };

    const isNoAudioStreamError = (raw: unknown): boolean => {
      const msg = raw instanceof Error ? raw.message : String(raw);
      const normalized = msg.toLowerCase();
      // Common ffmpeg messages when input has no audio stream or mapping yields no packets.
      return (
        normalized.includes('output file does not contain any stream') ||
        normalized.includes('matches no streams') ||
        normalized.includes('stream specifier') && normalized.includes('matches no streams') ||
        normalized.includes('no audio') && normalized.includes('stream')
      );
    };

    const writeEmptyTranscript = async (duration_s: number | null) => {
      const okSeg = await window.electronAPI.writeFile(outputPath, JSON.stringify([], null, 2));
      if (!okSeg) throw new Error('Failed to write transcript segments');

      const wordsPath = outputPath.replace(/\.json$/i, '_words.json');
      const okWords = await window.electronAPI.writeFile(
        wordsPath,
        JSON.stringify({ duration_s, text: '', words: [] }, null, 2)
      );
      if (!okWords) throw new Error('Failed to write transcript word timestamps');
    };

    this.log('[Parakeet Batch] Extracting audio with ffmpeg...', LogLevel.INFO);
    const audioResult = await window.electronAPI.extractAudioFromVideo(tempVideoPath);
    if (!audioResult.success || !audioResult.audioPath) {
      const raw = audioResult.error || 'Unknown error';
      if (isNoAudioStreamError(raw)) {
        this.log('[Parakeet Batch] No audio stream detected; using empty transcript.', LogLevel.WARN);
        try {
          await writeEmptyTranscript(null);
          onProgress?.(0);
          return;
        } finally {
          try {
            if (shouldCleanupVideo) {
              await window.electronAPI.deleteFile(tempVideoPath);
            }
          } catch {
            // ignore
          }
        }
      }
      throw new Error(`Audio extraction failed: ${raw}`);
    }

    this.log(
      `[Parakeet Batch] Audio extracted: ${(audioResult.size! / 1024 / 1024).toFixed(2)}MB`,
      LogLevel.SUCCESS
    );

    const cleanupBase = async () => {
      try {
        if (shouldCleanupVideo) {
          await window.electronAPI.deleteFile(tempVideoPath);
        }
        await window.electronAPI.deleteFile(audioResult.audioPath!);
      } catch (err) {
        const msg = String(err || '');
        if (msg.includes('ENOENT')) return;
        this.log(`[Parakeet Batch] Cleanup warning: ${err}`, LogLevel.WARN);
      }
    };

    const runBatch = async (
      wavPath: string
    ): Promise<{ segments: ParakeetBatchTranscriptSegment[]; words: ParakeetWordTimestamp[]; text: string; duration_s: number | null }> => {
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        let finished = false;

        const done = (err?: Error, res?: any) => {
          if (finished) return;
          finished = true;
          try {
            ws.close();
          } catch {
            // ignore
          }
          if (err) return reject(err);
          resolve(res);
        };

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello', client: 'batch', version: 1 }));
        };

        ws.onerror = () => {
          done(new Error('Parakeet worker connection failed'));
        };

        ws.onmessage = (evt) => {
          if (typeof evt.data !== 'string') return;
          let msg: any = null;
          try {
            msg = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (!msg) return;

          if (msg.type === 'status' && msg.state === 'ready') {
            ws.send(
              JSON.stringify({
                type: 'batch_transcribe',
                wav_path: wavPath,
                segment_seconds: segmentSeconds,
              })
            );
            return;
          }

          if (msg.type !== 'batch_result') return;

          if (!msg.ok) {
            done(new Error(msg.error || 'Batch transcription failed'));
            return;
          }

          const segments: ParakeetBatchTranscriptSegment[] = Array.isArray(msg.segments) ? msg.segments : [];
          const words: ParakeetWordTimestamp[] = Array.isArray(msg.words) ? msg.words : [];
          const text = typeof msg.text === 'string' ? msg.text : '';
          const duration_s = typeof msg.duration_s === 'number' ? msg.duration_s : null;
          done(undefined, { segments, words, text, duration_s });
        };

        ws.onclose = () => {
          // If the worker closes before we received a result, surface it as an error.
          if (!finished) done(new Error('Parakeet worker connection closed'));
        };
      });
    };

    const wavSize = typeof audioResult.size === 'number' ? audioResult.size : null;
    const wavDurationSeconds =
      wavSize && wavSize > 44 ? Math.max(0, (wavSize - 44) / (16000 * 2)) : null; // PCM16LE mono @ 16kHz

    const shouldChunk = wavDurationSeconds !== null && wavDurationSeconds > 300;
    if (!shouldChunk) {
      try {
        let segments: ParakeetBatchTranscriptSegment[] = [];
        let words: ParakeetWordTimestamp[] = [];
        let text = '';
        let duration_s: number | null = wavDurationSeconds;

        try {
          const res = await runBatch(audioResult.audioPath);
          segments = res.segments;
          words = res.words;
          text = res.text;
          duration_s = typeof res.duration_s === 'number' ? res.duration_s : duration_s;
        } catch (err) {
          if (isMissingWordTimestampsError(err)) {
            this.log('[Parakeet Batch] No word timestamps available; using empty transcript.', LogLevel.WARN);
            await writeEmptyTranscript(duration_s);
            onProgress?.(0);
            return;
          }
          throw err;
        }

        const okSeg = await window.electronAPI.writeFile(outputPath, JSON.stringify(segments, null, 2));
        if (!okSeg) throw new Error('Failed to write transcript segments');

        const wordsPath = outputPath.replace(/\.json$/i, '_words.json');
        const okWords = await window.electronAPI.writeFile(
          wordsPath,
          JSON.stringify({ duration_s, text, words }, null, 2)
        );
        if (!okWords) throw new Error('Failed to write transcript word timestamps');

        this.log(`[Parakeet Batch] Transcripts saved: ${segments.length} segment(s)`, LogLevel.SUCCESS);
        onProgress?.(segments.length);
        return;
      } finally {
        await cleanupBase();
      }
    }

    if (!window.electronAPI.extractWavSegment) {
      // Fall back to single-pass if the IPC handler isn't available.
      try {
        let segments: ParakeetBatchTranscriptSegment[] = [];
        let words: ParakeetWordTimestamp[] = [];
        let text = '';
        let duration_s: number | null = wavDurationSeconds;

        try {
          const res = await runBatch(audioResult.audioPath);
          segments = res.segments;
          words = res.words;
          text = res.text;
          duration_s = typeof res.duration_s === 'number' ? res.duration_s : duration_s;
        } catch (err) {
          if (isMissingWordTimestampsError(err)) {
            this.log('[Parakeet Batch] No word timestamps available; using empty transcript.', LogLevel.WARN);
            await writeEmptyTranscript(duration_s);
            onProgress?.(0);
            return;
          }
          throw err;
        }

        const okSeg = await window.electronAPI.writeFile(outputPath, JSON.stringify(segments, null, 2));
        if (!okSeg) throw new Error('Failed to write transcript segments');

        const wordsPath = outputPath.replace(/\.json$/i, '_words.json');
        const okWords = await window.electronAPI.writeFile(
          wordsPath,
          JSON.stringify({ duration_s, text, words }, null, 2)
        );
        if (!okWords) throw new Error('Failed to write transcript word timestamps');

        this.log(`[Parakeet Batch] Transcripts saved: ${segments.length} segment(s)`, LogLevel.SUCCESS);
        onProgress?.(segments.length);
        return;
      } finally {
        await cleanupBase();
      }
    }

    // Chunked transcription: split WAV into 5-minute-ish chunks with 1-segment overlap.
    // Important: keep `segment_seconds` unchanged; only drop whole segments in the overlap.
    const totalSeconds = wavDurationSeconds!;
    const overlapSeconds = segmentSeconds; // preserve segment grid

    const baseChunkSeconds = 300;
    let chunkSeconds = Math.floor(baseChunkSeconds / segmentSeconds) * segmentSeconds;
    chunkSeconds = Math.max(chunkSeconds, 2 * segmentSeconds);
    const stepSeconds = chunkSeconds - overlapSeconds;

    const mergedSegments: ParakeetBatchTranscriptSegment[] = [];
    const mergedWords: ParakeetWordTimestamp[] = [];
    let mergedSegmentCount = 0;

    try {
      let chunkIndex = 0;
      for (let chunkStart = 0; chunkStart < totalSeconds; chunkStart += stepSeconds, chunkIndex++) {
        const chunkDuration = Math.min(chunkSeconds, totalSeconds - chunkStart);

        const chunkRes = await window.electronAPI.extractWavSegment(audioResult.audioPath, chunkStart, chunkDuration);
        if (!chunkRes?.success || !chunkRes.audioPath) {
          throw new Error(chunkRes?.error || 'Failed to extract WAV chunk');
        }

        try {
          let segments: ParakeetBatchTranscriptSegment[] = [];
          let words: ParakeetWordTimestamp[] = [];
          try {
            const res = await runBatch(chunkRes.audioPath);
            segments = res.segments;
            words = res.words;
          } catch (err) {
            if (isMissingWordTimestampsError(err)) {
              this.log(
                `[Parakeet Batch] No word timestamps available at ~${chunkStart.toFixed(1)}s; using empty transcript for this chunk.`,
                LogLevel.WARN
              );
              segments = [];
              words = [];
            } else {
              throw err;
            }
          }

          const localCutoff = chunkIndex === 0 ? -Infinity : overlapSeconds;

          for (const s of segments) {
            const end = typeof s.end === 'number' ? s.end : s.start;
            if (!(end > localCutoff)) continue;
            mergedSegments.push({
              ...s,
              start: s.start + chunkStart,
              end: s.end + chunkStart,
            });
          }

          for (const w of words) {
            const wEnd = typeof w.end === 'number' ? w.end : typeof w.start === 'number' ? w.start : null;
            if (chunkIndex !== 0 && wEnd !== null && !(wEnd > localCutoff)) continue;
            const next: ParakeetWordTimestamp = { ...w };
            if (typeof next.start === 'number') next.start = next.start + chunkStart;
            if (typeof next.end === 'number') next.end = next.end + chunkStart;
            mergedWords.push(next);
          }

          mergedSegmentCount = mergedSegments.length;
          onProgress?.(mergedSegmentCount);
        } finally {
          try {
            await window.electronAPI.deleteFile(chunkRes.audioPath);
          } catch {
            // ignore
          }
        }
      }

      const mergedText = mergedSegments.map((s) => String(s.text || '').trim()).filter(Boolean).join(' ');

      const okSeg = await window.electronAPI.writeFile(outputPath, JSON.stringify(mergedSegments, null, 2));
      if (!okSeg) throw new Error('Failed to write transcript segments');

      const wordsPath = outputPath.replace(/\.json$/i, '_words.json');
      const okWords = await window.electronAPI.writeFile(
        wordsPath,
        JSON.stringify({ duration_s: totalSeconds, text: mergedText, words: mergedWords }, null, 2)
      );
      if (!okWords) throw new Error('Failed to write transcript word timestamps');

      this.log(`[Parakeet Batch] Transcripts saved: ${mergedSegments.length} segment(s)`, LogLevel.SUCCESS);
      onProgress?.(mergedSegments.length);
    } finally {
      await cleanupBase();
    }
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
