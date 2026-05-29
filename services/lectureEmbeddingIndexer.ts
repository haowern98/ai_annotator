import { env, pipeline, Tensor } from '@xenova/transformers';
import { LogLevel } from '../types';

type LogFn = (message: string, level?: LogLevel) => Promise<void> | void;

type TranscriptEntry = {
  text: string;
  timestamp: string;
  timestampMs?: number;
};

type SummaryEntry = {
  text: string;
  windowLabel: string;
};

type ExtractedFrame = {
  timestamp_ms: number;
  image_base64: string;
};

let globalIndexQueue: Promise<void> = Promise.resolve();

const parseTimestampMs = (timestamp: string): number => {
  // Try [HH:MM:SS] format first
  let match = timestamp.match(/\[?(\d+):(\d+):(\d+)\]?/);
  if (match) {
    const [, hours, minutes, seconds] = match;
    return (parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10)) * 1000;
  }

  // Try [MM:SS] format
  match = timestamp.match(/\[?(\d+):(\d+)\]?/);
  if (match) {
    const [, minutes, seconds] = match;
    return (parseInt(minutes, 10) * 60 + parseInt(seconds, 10)) * 1000;
  }

  return 0;
};

const parseWindowLabelMs = (windowLabel: string): { t0_ms: number; t1_ms: number } => {
  const raw = String(windowLabel || '').trim();

  // Formats:
  // - "[MM:SS]-[MM:SS]"
  // - "[HH:MM:SS]-[HH:MM:SS]"
  // - "Topics: M:SS-M:SS"
  const bracketMatch = raw.match(/\[(\d+:\d+(?::\d+)?)\]\s*-\s*\[(\d+:\d+(?::\d+)?)\]/);
  if (bracketMatch) {
    const t0_ms = parseTimestampMs(`[${bracketMatch[1]}]`);
    const t1_ms = parseTimestampMs(`[${bracketMatch[2]}]`);
    return { t0_ms, t1_ms: Math.max(t1_ms, t0_ms) };
  }

  const topicsMatch = raw.match(/topics:\s*(\d+:\d+(?::\d+)?)\s*-\s*(\d+:\d+(?::\d+)?)/i);
  if (topicsMatch) {
    const t0_ms = parseTimestampMs(`[${topicsMatch[1]}]`);
    const t1_ms = parseTimestampMs(`[${topicsMatch[2]}]`);
    return { t0_ms, t1_ms: Math.max(t1_ms, t0_ms) };
  }

  const single = parseTimestampMs(raw);
  return { t0_ms: single, t1_ms: single + 5000 };
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  // Avoid stack overflow on large arrays by chunking.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const float32ToBase64 = (vec: Float32Array): string => {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  return bytesToBase64(bytes);
};

export class LectureEmbeddingIndexer {
  private log: LogFn;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private textExtractor: any | null = null;
  private imageExtractor: any | null = null;

  constructor(log: LogFn) {
    this.log = log;
  }

  private async clearTransformersCacheBestEffort(): Promise<void> {
    try {
      // Transformers.js uses Cache API key: 'transformers-cache'
      if (typeof caches !== 'undefined') {
        await caches.delete('transformers-cache');
      }
    } catch {
      // ignore
    }
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Prefer GPU if available (WebGPU), but keep a WASM fallback.
      try {
        (env as any).backends.onnx.executionProviders = ['webgpu', 'wasm'];
      } catch {
        // ignore
      }

      // Keep cache under the app working directory unless a userData cache is wired later.
      // (Transformers.js will cache downloads via its configured cache mechanisms.)
      try {
        (env as any).allowRemoteModels = true;
        (env as any).allowLocalModels = true;

        const hfHost = String((import.meta as any)?.env?.VITE_HF_REMOTE_HOST || '').trim();
        if (hfHost) {
          (env as any).remoteHost = hfHost.endsWith('/') ? hfHost : `${hfHost}/`;
        }

        const hfPath = String((import.meta as any)?.env?.VITE_HF_REMOTE_PATH_TEMPLATE || '').trim();
        if (hfPath) {
          (env as any).remotePathTemplate = hfPath;
        }
      } catch {
        // ignore
      }

      await this.log('[Index] Loading embedding models... (first run may download model files)', LogLevel.INFO);

      const loadModels = async () => {
        // Text embeddings: multilingual (mixed language)
        this.textExtractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');

        // Image embeddings: CLIP (returns 512-d image embeddings)
        this.imageExtractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
      };

      try {
        await loadModels();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Common failure mode: model download got an HTML error page cached (<!DOCTYPE ...>),
        // which then crashes JSON parsing on next load.
        const looksLikeHtml = /Unexpected token '<'|<!DOCTYPE|not valid JSON/i.test(msg);
        if (looksLikeHtml) {
          await this.log('[Index] Model load failed (HTML response). Clearing transformers cache and retrying...', LogLevel.WARN);
          await this.clearTransformersCacheBestEffort();
          try {
            await loadModels();
          } catch (e2) {
            const msg2 = e2 instanceof Error ? e2.message : String(e2);
            throw new Error(
              `Embedding model download failed (received HTML instead of JSON). ` +
              `This usually means Hugging Face is blocked or intercepted by a captive portal/proxy. ` +
              `Original error: ${msg2}`
            );
          }
        } else {
          throw e;
        }
      }

      this.initialized = true;
      await this.log('[Index] Embedding models ready', LogLevel.SUCCESS);
    })();

    return this.initPromise;
  }

  private async getRecordingDirAndId(metadataPath: string): Promise<{ dir: string; lectureId: string }> {
    const normalized = metadataPath.replace(/\\/g, '/');
    const dir = normalized.replace(/\/[^/]+$/, '');
    const base = normalized.split('/').pop() || 'lecture';
    const lectureId = base.replace(/\.json$/i, '');
    return { dir, lectureId };
  }

  private async writeJson(filePath: string, obj: any): Promise<void> {
    const ok = await window.electronAPI.writeFile(filePath, JSON.stringify(obj, null, 2));
    if (!ok) throw new Error(`Failed to write ${filePath}`);
  }

  private async readJson<T>(filePath: string): Promise<T> {
    const raw = await window.electronAPI.readFile(filePath);
    return JSON.parse(raw) as T;
  }

  private async embedTextPassage(text: string): Promise<Float32Array> {
    const t: Tensor = await this.textExtractor(`passage: ${text}`, { pooling: 'mean', normalize: true });
    return t.data as Float32Array;
  }

  private async embedImageJpegBase64(jpegBase64: string): Promise<Float32Array> {
    const url = `data:image/jpeg;base64,${jpegBase64}`;
    const t: Tensor = await this.imageExtractor(url);
    return t.data as Float32Array;
  }

  public async indexBatchUploadRecording(opts: { metadataPath: string; frames: ExtractedFrame[] }): Promise<void> {
    // Serialize indexing across the whole app to avoid excessive memory usage
    // (embedding models + frames base64 are heavy).
    const run = async () => this.indexBatchUploadRecordingInternal(opts);
    const chained = globalIndexQueue.then(run, run);
    globalIndexQueue = chained.catch(() => undefined);
    return chained;
  }

  private async indexBatchUploadRecordingInternal(opts: { metadataPath: string; frames: ExtractedFrame[] }): Promise<void> {
    const metadataPath = String(opts.metadataPath || '').trim();
    if (!metadataPath) return;
    if (!window.electronAPI?.readFile || !window.electronAPI?.writeFile) {
      await this.log('[Index] Electron API unavailable; skipping indexing', LogLevel.WARN);
      return;
    }

    const frames = Array.isArray(opts.frames) ? opts.frames : [];
    if (frames.length === 0) return;

    try {
      await this.init();

      const { dir, lectureId } = await this.getRecordingDirAndId(metadataPath);
      const indexDir = `${dir}/${lectureId}_index`;

      // Mark indexing started in metadata (best effort).
      try {
        const meta = await this.readJson<any>(metadataPath);
        meta.embeddingIndex = {
          status: 'indexing',
          indexDir,
          startedAt: new Date().toISOString(),
          models: {
            text: 'Xenova/multilingual-e5-small',
            image: 'Xenova/clip-vit-base-patch32',
          },
        };
        await this.writeJson(metadataPath, meta);
      } catch {
        // ignore
      }

      await this.log(`[Index] Building embeddings index: ${lectureId}`, LogLevel.INFO);

      const metaObj = await this.readJson<{
        transcripts?: TranscriptEntry[];
        summaries?: SummaryEntry[];
      }>(metadataPath);

      const transcripts: TranscriptEntry[] = Array.isArray(metaObj.transcripts) ? metaObj.transcripts : [];
      const summaries: SummaryEntry[] = Array.isArray(metaObj.summaries) ? metaObj.summaries : [];

      // =====================================================
      // Transcript embeddings (per transcript entry)
      // =====================================================
      const transcriptLines: string[] = [];
      for (let i = 0; i < transcripts.length; i++) {
        const entry = transcripts[i];
        const text = String(entry?.text || '').trim();
        if (!text) continue;

        const t0_ms = typeof entry.timestampMs === 'number' ? entry.timestampMs : parseTimestampMs(String(entry.timestamp || ''));
        const t1_ms = i + 1 < transcripts.length
          ? (typeof transcripts[i + 1].timestampMs === 'number'
            ? transcripts[i + 1].timestampMs!
            : parseTimestampMs(String(transcripts[i + 1].timestamp || '')))
          : t0_ms + 5000;

        const emb = await this.embedTextPassage(text);
        transcriptLines.push(
          JSON.stringify({
            t0_ms,
            t1_ms: Math.max(t1_ms, t0_ms),
            text,
            emb_f32_b64: float32ToBase64(emb),
          })
        );

        if (i % 50 === 0) {
          await this.log(`[Index] Transcript embeddings: ${Math.min(i + 1, transcripts.length)}/${transcripts.length}`, LogLevel.INFO);
        }
      }

      await window.electronAPI.writeFile(`${indexDir}/transcripts.jsonl`, transcriptLines.join('\n'));

      // =====================================================
      // Summary embeddings (per summary entry)
      // =====================================================
      const summaryLines: string[] = [];
      for (let i = 0; i < summaries.length; i++) {
        const entry = summaries[i];
        const text = String(entry?.text || '').trim();
        if (!text) continue;

        const label = String(entry?.windowLabel || '').trim();
        const { t0_ms, t1_ms } = parseWindowLabelMs(label);

        const emb = await this.embedTextPassage(text);
        summaryLines.push(
          JSON.stringify({
            t0_ms,
            t1_ms: Math.max(t1_ms, t0_ms),
            window_label: label,
            text,
            emb_f32_b64: float32ToBase64(emb),
          })
        );

        if (i % 50 === 0) {
          await this.log(`[Index] Summary embeddings: ${Math.min(i + 1, summaries.length)}/${summaries.length}`, LogLevel.INFO);
        }
      }

      await window.electronAPI.writeFile(`${indexDir}/summaries.jsonl`, summaryLines.join('\n'));

      // =====================================================
      // Frame embeddings (all 1 FPS frames)
      // =====================================================
      const frameLines: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const b64 = String(f?.image_base64 || '');
        if (!b64) continue;

        const emb = await this.embedImageJpegBase64(b64);
        frameLines.push(
          JSON.stringify({
            t_ms: Number(f.timestamp_ms || 0),
            emb_f32_b64: float32ToBase64(emb),
          })
        );

        // Free some memory as we go (frames are huge base64 strings).
        // This does not affect the saved lecture.
        try {
          (frames[i] as any).image_base64 = '';
        } catch {
          // ignore
        }

        if (i % 50 === 0) {
          await this.log(`[Index] Frame embeddings: ${Math.min(i + 1, frames.length)}/${frames.length}`, LogLevel.INFO);
        }
      }

      await window.electronAPI.writeFile(`${indexDir}/frames.jsonl`, frameLines.join('\n'));

      // =====================================================
      // Index metadata
      // =====================================================
      await this.writeJson(`${indexDir}/meta.json`, {
        lectureId,
        createdAt: new Date().toISOString(),
        models: {
          text: 'Xenova/multilingual-e5-small',
          image: 'Xenova/clip-vit-base-patch32',
        },
        embeddingFormat: 'f32_base64',
        counts: {
          transcripts: transcriptLines.length,
          summaries: summaryLines.length,
          frames: frameLines.length,
        },
      });

      // Mark indexing complete in metadata (best effort).
      try {
        const meta = await this.readJson<any>(metadataPath);
        meta.embeddingIndex = {
          status: 'ready',
          indexDir,
          finishedAt: new Date().toISOString(),
          models: {
            text: 'Xenova/multilingual-e5-small',
            image: 'Xenova/clip-vit-base-patch32',
          },
          counts: {
            transcripts: transcriptLines.length,
            summaries: summaryLines.length,
            frames: frameLines.length,
          },
        };
        await this.writeJson(metadataPath, meta);
      } catch {
        // ignore
      }

      await this.log(`[Index] Index complete: ${lectureId}`, LogLevel.SUCCESS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.log(`[Index] Index failed: ${msg}`, LogLevel.ERROR);

      // Mark indexing error in metadata (best effort).
      try {
        const meta = await this.readJson<any>(metadataPath);
        const prev = meta.embeddingIndex || {};
        meta.embeddingIndex = {
          ...prev,
          status: 'error',
          error: msg,
          failedAt: new Date().toISOString(),
        };
        await this.writeJson(metadataPath, meta);
      } catch {
        // ignore
      }
    }
  }
}
