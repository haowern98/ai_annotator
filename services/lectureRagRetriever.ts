export type RagEvidence = {
  kind: 'transcript' | 'summary' | 'frame';
  score: number;
  t0_ms: number;
  t1_ms: number;
  text?: string;
  windowLabel?: string;
};

type JsonlTranscript = {
  t0_ms: number;
  t1_ms: number;
  text: string;
  emb_f32_b64?: string;
  embedding?: string;
};

type JsonlSummary = {
  t0_ms: number;
  t1_ms: number;
  window_label?: string;
  windowLabel?: string;
  text: string;
  emb_f32_b64?: string;
  embedding?: string;
};

type JsonlFrame = {
  t_ms?: number;
  t0_ms?: number;
  embedding?: string;
  emb_f32_b64?: string;
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const base64ToFloat32 = (b64: string): Float32Array => {
  const bytes = base64ToBytes(b64);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(buf);
};

const dot = (a: Float32Array, b: Float32Array): number => {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
};

const insertTopK = (arr: RagEvidence[], item: RagEvidence, k: number): void => {
  if (k <= 0) return;
  if (arr.length === 0) {
    arr.push(item);
    return;
  }
  let idx = arr.findIndex((x) => item.score > x.score);
  if (idx === -1) idx = arr.length;
  arr.splice(idx, 0, item);
  if (arr.length > k) arr.length = k;
};

async function embedQuery(query: string): Promise<Float32Array> {
  if (!window.electronAPI?.embedLectureQuery) {
    throw new Error('Electron API unavailable (embedLectureQuery)');
  }
  const res = await window.electronAPI.embedLectureQuery(query);
  if (!res?.success) throw new Error(res?.error || 'Failed to embed query');
  if (!res.emb_f32_b64) throw new Error('Missing query embedding');
  return base64ToFloat32(res.emb_f32_b64);
}

const readJsonlLines = async (path: string): Promise<string[]> => {
  if (!window.electronAPI?.readFile) throw new Error('Electron API unavailable');
  const raw = await window.electronAPI.readFile(path);
  return raw
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);
};

const getEmbB64 = (obj: any): string | null => {
  const b = (obj?.emb_f32_b64 || obj?.embedding) as any;
  const s = typeof b === 'string' ? b.trim() : '';
  return s ? s : null;
};

export async function retrieveLectureEvidence(opts: {
  indexDir: string;
  query: string;
  topKTranscripts?: number;
  topKSummaries?: number;
  topKFrames?: number;
}): Promise<{ transcripts: RagEvidence[]; summaries: RagEvidence[]; frames: RagEvidence[] }> {
  const indexDir = String(opts.indexDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const query = String(opts.query || '').trim();
  if (!indexDir) throw new Error('Missing indexDir');
  if (!query) return { transcripts: [], summaries: [], frames: [] };

  const topKTranscripts = clamp(Number(opts.topKTranscripts ?? 12), 0, 50);
  const topKSummaries = clamp(Number(opts.topKSummaries ?? 12), 0, 50);
  const topKFrames = clamp(Number(opts.topKFrames ?? 6), 0, 30);

  const q = await embedQuery(query);

  const transcriptHits: RagEvidence[] = [];
  const summaryHits: RagEvidence[] = [];
  const frameHits: RagEvidence[] = [];

  // Transcripts
  try {
    const lines = await readJsonlLines(`${indexDir}/transcripts.jsonl`);
    for (const line of lines) {
      const obj = JSON.parse(line) as JsonlTranscript;
      const embB64 = getEmbB64(obj);
      if (!embB64) continue;
      const emb = base64ToFloat32(embB64);
      insertTopK(
        transcriptHits,
        {
          kind: 'transcript',
          score: dot(q, emb),
          t0_ms: Number(obj.t0_ms || 0),
          t1_ms: Number(obj.t1_ms || obj.t0_ms || 0),
          text: String(obj.text || '').trim(),
        },
        topKTranscripts
      );
    }
  } catch {
    // missing transcripts.jsonl is OK (older recordings or indexing failures)
  }

  // Summaries
  try {
    const lines = await readJsonlLines(`${indexDir}/summaries.jsonl`);
    for (const line of lines) {
      const obj = JSON.parse(line) as JsonlSummary;
      const embB64 = getEmbB64(obj);
      if (!embB64) continue;
      const emb = base64ToFloat32(embB64);
      const label = String((obj as any).window_label || (obj as any).windowLabel || '').trim();
      insertTopK(
        summaryHits,
        {
          kind: 'summary',
          score: dot(q, emb),
          t0_ms: Number(obj.t0_ms || 0),
          t1_ms: Number(obj.t1_ms || obj.t0_ms || 0),
          windowLabel: label,
          text: String(obj.text || '').trim(),
        },
        topKSummaries
      );
    }
  } catch {
    // missing summaries.jsonl is OK
  }

  // Frames (timestamps only for now; v1 does not send images to the LLM)
  try {
    const lines = await readJsonlLines(`${indexDir}/frames.jsonl`);
    for (const line of lines) {
      const obj = JSON.parse(line) as JsonlFrame;
      const embB64 = getEmbB64(obj);
      if (!embB64) continue;
      const emb = base64ToFloat32(embB64);
      const t = Number((obj as any).t_ms ?? (obj as any).t0_ms ?? 0);
      insertTopK(
        frameHits,
        {
          kind: 'frame',
          score: dot(q, emb),
          t0_ms: t,
          t1_ms: t,
        },
        topKFrames
      );
    }
  } catch {
    // missing frames.jsonl is OK
  }

  return { transcripts: transcriptHits, summaries: summaryHits, frames: frameHits };
}
