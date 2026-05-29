const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const { app } = require('electron');

function findFfmpegExe() {
  const fromEnv = process.env.FFMPEG_EXE || process.env.VIDEOCONTEXT_FFMPEG_EXE;
  if (fromEnv && fsSync.existsSync(fromEnv)) return fromEnv;

  const shim = path.join(__dirname, '..', '..', 'qwen_worker', '.ffmpeg_shim', 'ffmpeg.exe');
  if (fsSync.existsSync(shim)) return shim;

  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = String(res.stdout || '').split(/\r?\n/).find(Boolean);
      if (first && fsSync.existsSync(first.trim())) return first.trim();
    }
  } catch {
    // ignore
  }

  return null;
}

async function runFfmpeg(args) {
  const ffmpegExe = findFfmpegExe();
  if (!ffmpegExe) {
    throw new Error('ffmpeg not found (set FFMPEG_EXE or start qwen_worker first)');
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (buf) => {
      stderr = (stderr + String(buf)).slice(-8000);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

const bytesToBase64 = (bytes) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return Buffer.from(binary, 'binary').toString('base64');
};

const float32ToBase64 = (vec) => {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  return bytesToBase64(bytes);
};

function parseTimestampMs(timestamp) {
  let match = String(timestamp || '').match(/\[?(\d+):(\d+):(\d+)\]?/);
  if (match) {
    const [, hours, minutes, seconds] = match;
    return (parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10)) * 1000;
  }

  match = String(timestamp || '').match(/\[?(\d+):(\d+)\]?/);
  if (match) {
    const [, minutes, seconds] = match;
    return (parseInt(minutes, 10) * 60 + parseInt(seconds, 10)) * 1000;
  }

  return 0;
}

function parseWindowLabelMs(windowLabel) {
  const raw = String(windowLabel || '').trim();

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
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath, obj) {
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

async function loadTransformersModels(progressCb) {
  const { env, pipeline } = await import('@xenova/transformers');

  // Force offline usage: do not hit Hugging Face.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  // Ensure FS cache is writable (packaged apps may have readonly node_modules).
  // If the module cache dir is not writable, use userData instead.
  const moduleCacheDir = env.cacheDir;
  const userCacheDir = path.join(app.getPath('userData'), 'transformers-cache');
  try {
    if (!env.cacheDir) throw new Error('no cacheDir');
    const testPath = path.join(env.cacheDir, '.write_test');
    await fs.writeFile(testPath, 'ok', 'utf8');
    await fs.unlink(testPath);
  } catch {
    env.cacheDir = userCacheDir;
  }

  await ensureDir(env.cacheDir);

  // If we redirected cacheDir, best-effort copy of already-downloaded models
  // from module cache into the new writable cache location.
  if (env.cacheDir !== moduleCacheDir && moduleCacheDir && fsSync.existsSync(moduleCacheDir)) {
    const copyDir = async (src, dst) => {
      await ensureDir(dst);
      const entries = await fs.readdir(src, { withFileTypes: true });
      for (const e of entries) {
        const s = path.join(src, e.name);
        const d = path.join(dst, e.name);
        if (e.isDirectory()) {
          await copyDir(s, d);
        } else if (e.isFile()) {
          try {
            await fs.copyFile(s, d);
          } catch {
            // ignore
          }
        }
      }
    };

    const ensureModelCopied = async (modelId) => {
      const srcDir = path.join(moduleCacheDir, modelId);
      const dstDir = path.join(env.cacheDir, modelId);
      if (!fsSync.existsSync(dstDir) && fsSync.existsSync(srcDir)) {
        await copyDir(srcDir, dstDir);
      }
    };

    // Models used by this indexer:
    await ensureModelCopied(path.join('Xenova', 'multilingual-e5-small'));
    await ensureModelCopied(path.join('Xenova', 'clip-vit-base-patch32'));
  }

  const log = (x) => {
    try {
      if (progressCb) progressCb(x);
    } catch {
      // ignore
    }
  };

  const textExtractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
    progress_callback: log,
    local_files_only: true,
  });
  const imageExtractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', {
    progress_callback: log,
    local_files_only: true,
  });

  return { textExtractor, imageExtractor, env };
}

let cachedModels = null;
let cachedModelsPromise = null;

async function getModels(progressCb) {
  if (cachedModels) return cachedModels;
  if (cachedModelsPromise) return cachedModelsPromise;
  cachedModelsPromise = loadTransformersModels(progressCb).then((m) => {
    cachedModels = m;
    return m;
  });
  return cachedModelsPromise;
}

async function extractFramesToDir(videoPath, framesDir) {
  await ensureDir(framesDir);
  // 1 fps, jpeg, deterministic names
  const outPattern = path.join(framesDir, 'frame_%06d.jpg');
  await runFfmpeg([
    '-hide_banner',
    '-y',
    '-i',
    videoPath,
    '-vf',
    'fps=1',
    '-q:v',
    '3',
    outPattern,
  ]);

  const files = (await fs.readdir(framesDir)).filter((f) => /\.jpe?g$/i.test(f)).sort();
  return files.map((f, idx) => ({
    file: f,
    path: path.join(framesDir, f),
    timestamp_ms: idx * 1000,
  }));
}

async function indexLectureEmbeddings({ metadataPath, includeFrames = true, progressCb, statusCb }) {
  const metaPath = String(metadataPath || '').trim();
  if (!metaPath) throw new Error('Missing metadataPath');

  const dir = path.dirname(metaPath);
  const lectureId = path.basename(metaPath).replace(/\.json$/i, '');
  const indexDir = path.join(dir, `${lectureId}_index`);
  await ensureDir(indexDir);

  const metadata = await readJson(metaPath);

  metadata.embeddingIndex = {
    status: 'indexing',
    indexDir,
    startedAt: new Date().toISOString(),
    models: {
      text: 'Xenova/multilingual-e5-small',
      image: 'Xenova/clip-vit-base-patch32',
    },
  };
  await writeJson(metaPath, metadata);

  const safeStatus = (payload) => {
    try {
      if (typeof statusCb === 'function') statusCb(payload);
    } catch {
      // ignore
    }
  };

  try {
    const transcripts = Array.isArray(metadata.transcripts) ? metadata.transcripts : [];
    const summaries = Array.isArray(metadata.summaries) ? metadata.summaries : [];

    const { textExtractor, imageExtractor } = await getModels(progressCb);

    const transcriptsPath = path.join(indexDir, 'transcripts.jsonl');
    const summariesPath = path.join(indexDir, 'summaries.jsonl');
    const framesPath = path.join(indexDir, 'frames.jsonl');
    const indexMetaPath = path.join(indexDir, 'meta.json');

    await fs.writeFile(transcriptsPath, '', 'utf8');
    await fs.writeFile(summariesPath, '', 'utf8');
    await fs.writeFile(framesPath, '', 'utf8');

    let transcriptCount = 0;
    let summaryCount = 0;
    let frameCount = 0;

    const totalTranscripts = transcripts.filter((t) => String(t?.text || '').trim()).length;
    const totalSummaries = summaries.filter((s) => String(s?.text || '').trim()).length;

    safeStatus({
      phase: 'Embedding transcripts',
      counts: { transcriptsDone: 0, transcriptsTotal: totalTranscripts, summariesDone: 0, summariesTotal: totalSummaries, framesDone: 0, framesTotal: null },
    });

    for (const t of transcripts) {
      const text = String(t?.text || '').trim();
      if (!text) continue;
      const timestamp = String(t?.timestamp || '').trim();
      const t0_ms = Number.isFinite(t?.timestampMs) ? Number(t.timestampMs) : parseTimestampMs(timestamp);
      const t1_ms = t0_ms + 5000;
      const tensor = await textExtractor(`passage: ${text}`, { pooling: 'mean', normalize: true });
      const vec = tensor.data;
      await fs.appendFile(
        transcriptsPath,
        JSON.stringify({ type: 'transcript', t0_ms, t1_ms, text, embedding: float32ToBase64(vec) }) + '\n',
        'utf8'
      );
      transcriptCount++;
      if (transcriptCount % 10 === 0 || transcriptCount === totalTranscripts) {
        safeStatus({
          phase: 'Embedding transcripts',
          counts: { transcriptsDone: transcriptCount, transcriptsTotal: totalTranscripts, summariesDone: 0, summariesTotal: totalSummaries, framesDone: 0, framesTotal: null },
        });
      }
    }

    safeStatus({
      phase: 'Embedding summaries',
      counts: { transcriptsDone: transcriptCount, transcriptsTotal: totalTranscripts, summariesDone: 0, summariesTotal: totalSummaries, framesDone: 0, framesTotal: null },
    });

    for (const s of summaries) {
      const text = String(s?.text || '').trim();
      if (!text) continue;
      const windowLabel = String(s?.windowLabel || '').trim();
      const { t0_ms, t1_ms } = parseWindowLabelMs(windowLabel);
      const tensor = await textExtractor(`passage: ${text}`, { pooling: 'mean', normalize: true });
      const vec = tensor.data;
      await fs.appendFile(
        summariesPath,
        JSON.stringify({ type: 'summary', t0_ms, t1_ms, windowLabel, text, embedding: float32ToBase64(vec) }) + '\n',
        'utf8'
      );
      summaryCount++;
      if (summaryCount % 5 === 0 || summaryCount === totalSummaries) {
        safeStatus({
          phase: 'Embedding summaries',
          counts: { transcriptsDone: transcriptCount, transcriptsTotal: totalTranscripts, summariesDone: summaryCount, summariesTotal: totalSummaries, framesDone: 0, framesTotal: null },
        });
      }
    }

    if (includeFrames) {
      const videoFilename = String(metadata.videoFilename || '').trim();
      const videoPath = String(metadata.videoPath || '').trim() || (videoFilename ? path.join(dir, videoFilename) : '');
      if (videoPath && fsSync.existsSync(videoPath)) {
        const framesDir = path.join(indexDir, 'frames_1fps');
        safeStatus({
          phase: 'Extracting frames (1 fps)',
          counts: { transcriptsDone: transcriptCount, transcriptsTotal: totalTranscripts, summariesDone: summaryCount, summariesTotal: totalSummaries, framesDone: 0, framesTotal: null },
        });
        const frames = await extractFramesToDir(videoPath, framesDir);
        const totalFrames = frames.length;
        safeStatus({
          phase: 'Embedding frames',
          counts: { transcriptsDone: transcriptCount, transcriptsTotal: totalTranscripts, summariesDone: summaryCount, summariesTotal: totalSummaries, framesDone: 0, framesTotal: totalFrames },
        });
        for (const fr of frames) {
          // IMPORTANT: In Node/electron-main, Transformers.js getFile() does not support `data:` URLs.
          // Pass a local file path instead so it loads via filesystem.
          const tensor = await imageExtractor(fr.path);
          const vec = tensor.data;
          await fs.appendFile(
            framesPath,
            JSON.stringify({
              type: 'frame',
              t0_ms: fr.timestamp_ms,
              t1_ms: fr.timestamp_ms + 1000,
              imagePath: fr.path,
              embedding: float32ToBase64(vec),
            }) + '\n',
            'utf8'
          );
          frameCount++;
          if (frameCount % 10 === 0 || frameCount === totalFrames) {
            safeStatus({
              phase: 'Embedding frames',
              counts: { transcriptsDone: transcriptCount, transcriptsTotal: totalTranscripts, summariesDone: summaryCount, summariesTotal: totalSummaries, framesDone: frameCount, framesTotal: totalFrames },
            });
          }
        }
      }
    }

    safeStatus({
      phase: 'Finalizing index',
      counts: { transcriptsDone: transcriptCount, transcriptsTotal: totalTranscripts, summariesDone: summaryCount, summariesTotal: totalSummaries, framesDone: frameCount, framesTotal: includeFrames ? frameCount : 0 },
    });

    await writeJson(indexMetaPath, {
      lectureId,
      createdAt: new Date().toISOString(),
      counts: { transcripts: transcriptCount, summaries: summaryCount, frames: frameCount },
      models: { text: 'Xenova/multilingual-e5-small', image: 'Xenova/clip-vit-base-patch32' },
    });

    const updated = await readJson(metaPath);
    updated.embeddingIndex = {
      status: 'ready',
      indexDir,
      completedAt: new Date().toISOString(),
      counts: { transcripts: transcriptCount, summaries: summaryCount, frames: frameCount },
      models: { text: 'Xenova/multilingual-e5-small', image: 'Xenova/clip-vit-base-patch32' },
    };
    await writeJson(metaPath, updated);

    return { success: true, lectureId, indexDir };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const updated = await readJson(metaPath);
      updated.embeddingIndex = {
        ...(updated.embeddingIndex || {}),
        status: 'error',
        error: msg,
        failedAt: new Date().toISOString(),
      };
      await writeJson(metaPath, updated);
    } catch {
      // ignore
    }
    throw err;
  }
}

function setupEmbeddingIndexHandlers(ipcMain) {
  ipcMain.handle('embedding:indexLecture', async (_event, metadataPath, opts) => {
    const options = opts && typeof opts === 'object' ? opts : {};
    return await indexLectureEmbeddings({
      metadataPath,
      includeFrames: options.includeFrames !== false,
      progressCb: null,
    });
  });

  ipcMain.handle('embedding:embedQuery', async (_event, queryRaw) => {
    const query = String(queryRaw || '').trim();
    if (!query) return { success: false, error: 'Missing query' };
    const { textExtractor } = await getModels(null);
    const tensor = await textExtractor(`query: ${query}`, { pooling: 'mean', normalize: true });
    const vec = tensor.data;
    return { success: true, emb_f32_b64: float32ToBase64(vec) };
  });
}

function setupEmbeddingIndexHandlersWithSender(ipcMain, sendToRenderer) {
  const send = typeof sendToRenderer === 'function' ? sendToRenderer : null;

  const emit = (payload) => {
    try {
      if (send) send('embedding:indexProgress', payload);
    } catch {
      // ignore
    }
  };

  ipcMain.handle('embedding:indexLecture', async (_event, metadataPath, opts) => {
    const options = opts && typeof opts === 'object' ? opts : {};
    const metaPath = String(metadataPath || '').trim();
    const lectureId = path.basename(metaPath).replace(/\.json$/i, '');

    const progressCb = (x) => {
      // Model download progress etc.
      try {
        if (!x || typeof x !== 'object') return;
        const status = String(x.status || '');
        const file = x.file ? String(x.file) : '';
        const progress = Number.isFinite(x.progress) ? Number(x.progress) : null;
        emit({
          lectureId,
          status: 'indexing',
          phase: status ? `Loading models${file ? `: ${file}` : ''}` : 'Loading models',
          percentage: progress,
          counts: null,
        });
      } catch {
        // ignore
      }
    };

    emit({ lectureId, status: 'indexing', phase: 'Starting', percentage: 0, counts: null });

    try {
      const res = await indexLectureEmbeddings({
        metadataPath: metaPath,
        includeFrames: options.includeFrames !== false,
        progressCb,
        statusCb: (s) => {
          try {
            const phase = String(s?.phase || 'Indexing');
            const counts = s?.counts || null;
            let percentage = null;
            if (counts) {
              const tDone = Number(counts.transcriptsDone || 0);
              const tTot = Number(counts.transcriptsTotal || 0);
              const sDone = Number(counts.summariesDone || 0);
              const sTot = Number(counts.summariesTotal || 0);
              const fDone = Number(counts.framesDone || 0);
              const fTotRaw = counts.framesTotal;
              const fTot = fTotRaw === null || fTotRaw === undefined ? null : Number(fTotRaw);

              // Percent computed from real counts, with frames dominating time.
              // If frames total unknown (during extraction), compute percent from transcripts+summaries only.
              const frac = (done, tot) => (tot > 0 ? Math.max(0, Math.min(1, done / tot)) : 0);
              const tFrac = frac(tDone, tTot);
              const sFrac = frac(sDone, sTot);
              const fFrac = fTot ? frac(fDone, fTot) : 0;

              const hasFrames = Boolean(fTot && fTot > 0);
              const wT = hasFrames ? 0.1 : 0.5;
              const wS = hasFrames ? 0.1 : 0.5;
              const wF = hasFrames ? 0.8 : 0.0;
              percentage = Math.round((wT * tFrac + wS * sFrac + wF * fFrac) * 100);
            }

            emit({ lectureId, status: 'indexing', phase, percentage, counts });
          } catch {
            // ignore
          }
        },
      });
      emit({ lectureId, status: 'ready', phase: 'Complete', percentage: 100, counts: null });
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ lectureId, status: 'error', phase: msg || 'Indexing failed', percentage: null, counts: null });
      throw err;
    }
  });

  ipcMain.handle('embedding:embedQuery', async (_event, queryRaw) => {
    const query = String(queryRaw || '').trim();
    if (!query) return { success: false, error: 'Missing query' };
    const { textExtractor } = await getModels(null);
    const tensor = await textExtractor(`query: ${query}`, { pooling: 'mean', normalize: true });
    const vec = tensor.data;
    return { success: true, emb_f32_b64: float32ToBase64(vec) };
  });
}

module.exports = { setupEmbeddingIndexHandlers, setupEmbeddingIndexHandlersWithSender };
