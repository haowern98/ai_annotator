const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;

let recordingsDir = null;

// Initialize recordings directory
async function initRecordingsDir() {
  if (recordingsDir) return recordingsDir;
  
  // Store recordings inside the repo by default (dev-friendly).
  recordingsDir = path.join(__dirname, '..', '..', '.recordings');
  
  try {
    await fs.mkdir(recordingsDir, { recursive: true });
    console.log('[Recording] Recordings directory initialized:', recordingsDir);
    return recordingsDir;
  } catch (err) {
    console.error('[Recording] Failed to create recordings directory:', err);
    throw err;
  }
}

// Generate filename with timestamp
function generateFilename() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `lecture_${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function sanitizeBaseFilename(name) {
  const raw = String(name || '').trim();
  const base = raw.split(/[\\/]/).pop() || '';
  const safe = base.replace(/[^\w.\- ]+/g, '').trim().slice(0, 160);
  return safe || generateFilename();
}

function sanitizeTitle(title) {
  const t = String(title ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.slice(0, 80);
}

function metaPathForId(dir, baseFilename) {
  const safe = String(baseFilename || '').trim().replace(/\.(json|webm|mp4)$/i, '');
  return path.join(dir, `${safe}.meta.json`);
}

async function readTitleOverride(dir, baseFilename) {
  const p = metaPathForId(dir, baseFilename);
  try {
    const content = await fs.readFile(p, 'utf8');
    const obj = JSON.parse(content);
    const t = sanitizeTitle(obj?.title);
    return t;
  } catch {
    return null;
  }
}

async function writeTitleOverride(dir, baseFilename, title) {
  const p = metaPathForId(dir, baseFilename);
  const t = sanitizeTitle(title);
  if (!t) {
    try {
      await fs.unlink(p);
    } catch {
      // ignore
    }
    return { success: true, title: null, cleared: true };
  }

  const payload = {
    title: t,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(p, JSON.stringify(payload, null, 2));
  return { success: true, title: t, cleared: false };
}

function setupRecordingHandlers(ipcMain) {
  // Initialize and return recordings directory path
  ipcMain.handle('recording:init', async () => {
    try {
      const dir = await initRecordingsDir();
      return { success: true, path: dir };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Save video recording and metadata
  ipcMain.handle('recording:save', async (event, videoData, metadata) => {
    try {
      const dir = await initRecordingsDir();
      const baseFilename = generateFilename();
      const metadataFilename = `${baseFilename}.json`;
      const metadataPath = path.join(dir, metadataFilename);

      // Debug: Log what we received
      console.log('[Recording] Save called with:', {
        hasVideoData: !!videoData,
        videoDataType: typeof videoData,
        hasMetadata: !!metadata,
        metadataKeys: metadata ? Object.keys(metadata) : 'none',
        recordedMimeType: metadata?.recordedMimeType,
        quality: metadata?.quality
      });

      let videoPath = '';
      let videoFilename = '';
      let fileSize = 0;

      // Only save video if videoData is provided (not null/undefined)
      if (videoData) {
        // Use .mp4 for MP4 recordings, .webm for others
        const recordedMimeType = metadata?.recordedMimeType || 'video/webm';
        const isMp4 = recordedMimeType.includes('mp4');
        const videoExtension = isMp4 ? '.mp4' : '.webm';
        console.log('[Recording] Determining extension:', { recordedMimeType, isMp4, videoExtension });
        
        videoFilename = `${baseFilename}${videoExtension}`;
        videoPath = path.join(dir, videoFilename);

        // Convert base64 or ArrayBuffer to Buffer
        let videoBuffer;
        if (typeof videoData === 'string') {
          // Base64 string
          videoBuffer = Buffer.from(videoData, 'base64');
        } else if (videoData instanceof ArrayBuffer) {
          videoBuffer = Buffer.from(videoData);
        } else if (Buffer.isBuffer(videoData)) {
          videoBuffer = videoData;
        } else {
          throw new Error('Invalid video data format');
        }

        // Save video file
        await fs.writeFile(videoPath, videoBuffer);
        fileSize = videoBuffer.length;
        console.log('[Recording] Video saved:', videoPath, `(${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
      } else {
        // For metadata-only saves, use .mp4 as placeholder for date/time parsing
        videoFilename = `${baseFilename}.mp4`;
        console.log('[Recording] No video data - saving metadata only');
      }

      const normalizeOrigin = (o) => {
        if (!o || typeof o !== 'object') return { kind: 'local' };
        const kind = o.kind === 'remote' ? 'remote' : 'local';
        const serverUrl = typeof o.serverUrl === 'string' ? o.serverUrl : undefined;
        const serverId = typeof o.serverId === 'string' ? o.serverId : undefined;
        return {
          kind,
          ...(serverUrl ? { serverUrl } : {}),
          ...(serverId ? { serverId } : {}),
        };
      };

      // Add file info to metadata
      const fullMetadata = {
        ...metadata,
        origin: normalizeOrigin(metadata?.origin),
        videoFilename: videoFilename, // Always include filename for date/time parsing
        videoPath: videoPath, // Empty if no video
        savedAt: new Date().toISOString(),
        fileSize: fileSize // 0 if no video
      };

      // Save metadata
      await fs.writeFile(metadataPath, JSON.stringify(fullMetadata, null, 2));
      console.log('[Recording] Metadata saved:', metadataPath);

      return { 
        success: true, 
        videoPath, 
        metadataPath,
        filename: baseFilename
      };
    } catch (err) {
      console.error('[Recording] Failed to save recording:', err);
      return { success: false, error: err.message };
    }
  });

  // List all saved recordings
  ipcMain.handle('recording:list', async () => {
    try {
      const dir = await initRecordingsDir();
      const files = await fs.readdir(dir);
      
      // Find all metadata JSON files
      const metadataFiles = files.filter((f) => {
        if (!f.endsWith('.json')) return false;
        if (f.endsWith('.meta.json')) return false;
        // Exclude auxiliary files (e.g. word timestamp dumps) that live next to metadata.
        if (f.endsWith('_words.json')) return false;
        // Exclude remote overlay manifests and per-chunk artifacts.
        if (f.endsWith('_manifest.json')) return false;
        if (/_overlay_remote_chunk_\d{4}\.json$/i.test(f)) return false;
        return true;
      });
      
      const recordings = await Promise.all(
        metadataFiles.map(async (filename) => {
          try {
            const metadataPath = path.join(dir, filename);
            const content = await fs.readFile(metadataPath, 'utf8');
            const rec = JSON.parse(content);
            const baseId = String(filename || '').replace(/\.json$/i, '');
            const userTitle = await readTitleOverride(dir, baseId);
            if (userTitle) rec.userTitle = userTitle;
            return rec;
          } catch (err) {
            console.error('[Recording] Failed to read metadata:', filename, err);
            return null;
          }
        })
      );

      // Filter out failed reads and sort by date (newest first)
      const validRecordings = recordings
        .filter((r) => r !== null && typeof r === 'object')
        .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

      return { success: true, recordings: validRecordings };
    } catch (err) {
      console.error('[Recording] Failed to list recordings:', err);
      return { success: false, error: err.message };
    }
  });

  // Delete a recording (both video and metadata files)
  ipcMain.handle('recording:delete', async (event, videoFilename) => {
    try {
      const dir = await initRecordingsDir();
      const baseFilename = videoFilename.replace(/\.(webm|mp4|json)$/, '');
      const metadataPath = path.join(dir, `${baseFilename}.json`);
      const metaPath = metaPathForId(dir, baseFilename);

      // Try to delete video file - support both .mp4 and .webm extensions
      const extensionsToTry = ['.mp4', '.webm'];
      for (const ext of extensionsToTry) {
        const videoPath = path.join(dir, `${baseFilename}${ext}`);
        try {
          await fs.access(videoPath);
          await fs.unlink(videoPath);
          console.log('[Recording] Video deleted:', videoPath);
          break; // Successfully deleted, stop trying
        } catch (err) {
          // File doesn't exist with this extension, try next
          console.log('[Recording] No file with extension', ext, '- trying next');
        }
      }

      // Delete metadata file
      try {
        await fs.access(metadataPath);
        await fs.unlink(metadataPath);
        console.log('[Recording] Metadata deleted:', metadataPath);
      } catch (err) {
        console.error('[Recording] Failed to delete metadata:', err);
        throw new Error('Metadata file not found');
      }

      // Delete title override file (if present)
      try {
        await fs.access(metaPath);
        await fs.unlink(metaPath);
        console.log('[Recording] Title override deleted:', metaPath);
      } catch {
        // ignore
      }

      return { success: true };
    } catch (err) {
      console.error('[Recording] Failed to delete recording:', err);
      return { success: false, error: err.message };
    }
  });

  // Get recording metadata by filename (supports both .mp4 and .webm)
  ipcMain.handle('recording:metadata', async (event, videoFilename) => {
    try {
      const dir = await initRecordingsDir();
      const baseFilename = videoFilename.replace(/\.(webm|mp4|json)$/, '');
      const metadataPath = path.join(dir, `${baseFilename}.json`);

      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);
      const userTitle = await readTitleOverride(dir, baseFilename);
      if (userTitle) metadata.userTitle = userTitle;

      return { success: true, metadata };
    } catch (err) {
      console.error('[Recording] Failed to read metadata:', err);
      return { success: false, error: err.message };
    }
  });

  // Set or clear lecture display title override (stored in <lectureId>.meta.json).
  ipcMain.handle('recording:setTitle', async (event, lectureId, title) => {
    try {
      const dir = await initRecordingsDir();
      const id = String(lectureId || '').trim().replace(/\.(json|webm|mp4)$/i, '');
      if (!id) return { success: false, error: 'Missing lectureId' };

      // Ensure the lecture exists (metadata file is the source of truth).
      const metadataPath = path.join(dir, `${id}.json`);
      await fs.access(metadataPath);

      return await writeTitleOverride(dir, id, title);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get video file as base64 for playback (supports both .mp4 and .webm)
  ipcMain.handle('recording:getVideo', async (event, videoFilename) => {
    try {
      const dir = await initRecordingsDir();
      const baseFilename = videoFilename.replace(/\.(webm|mp4|json)$/, '');

      // Try to find video file with either extension
      const extensionsToTry = ['.mp4', '.webm'];
      let videoPath = '';
      let mimeType = 'video/webm'; // Default fallback

      for (const ext of extensionsToTry) {
        const testPath = path.join(dir, `${baseFilename}${ext}`);
        try {
          await fs.access(testPath);
          videoPath = testPath;
          mimeType = ext === '.mp4' ? 'video/mp4' : 'video/webm';
          console.log('[Recording] Found video file:', videoPath);
          break;
        } catch (err) {
          // File doesn't exist with this extension, try next
        }
      }

      if (!videoPath) {
        throw new Error(`Video file not found for ${baseFilename}`);
      }

      // Avoid crashing the renderer by base64-encoding huge files.
      // Use `recording:getVideoPath` for large videos to enable streaming playback.
      const st = await fs.stat(videoPath);
      if (st.size > 50 * 1024 * 1024) {
        return {
          success: false,
          error: `Video too large for base64 transfer (${Math.round(st.size / 1024 / 1024)}MB). Use recording:getVideoPath.`,
          mimeType,
        };
      }

      // Read video file
      const videoData = await fs.readFile(videoPath);
      const base64Data = videoData.toString('base64');
      
      return { 
        success: true, 
        data: base64Data,
        mimeType: mimeType
      };
    } catch (err) {
      console.error('[Recording] Failed to read video:', err);
      return { success: false, error: err.message };
    }
  });

  // Pick a local video file using a native dialog (returns a filesystem path, not a browser File).
  ipcMain.handle('recording:pickVideoFile', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select a video file',
        properties: ['openFile'],
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePaths?.length) {
        return { success: true, canceled: true };
      }

      const filePath = result.filePaths[0];
      const st = await fs.stat(filePath);
      return {
        success: true,
        canceled: false,
        path: filePath,
        name: path.basename(filePath),
        size: st.size,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Copy an existing local video file into the recordings directory immediately (ingest step).
  // This avoids loading huge files into renderer memory.
  ipcMain.handle('recording:ingestVideo', async (event, sourcePath) => {
    try {
      const src = String(sourcePath || '').trim();
      if (!src) return { success: false, error: 'Missing sourcePath' };

      const dir = await initRecordingsDir();
      const st = await fs.stat(src);
      if (!st.isFile()) return { success: false, error: 'Source is not a file' };

      const ext = (path.extname(src) || '').toLowerCase() || '.mp4';
      let baseFilename = `${generateFilename()}_upload`;
      let videoFilename = `${baseFilename}${ext}`;
      let videoPath = path.join(dir, videoFilename);

      // Ensure uniqueness (avoid collisions when importing multiple files quickly).
      for (let i = 0; i < 50; i++) {
        try {
          await fs.access(videoPath);
          baseFilename = `${generateFilename()}_upload_${i + 1}`;
          videoFilename = `${baseFilename}${ext}`;
          videoPath = path.join(dir, videoFilename);
        } catch {
          break;
        }
      }

      await fs.copyFile(src, videoPath);
      const st2 = await fs.stat(videoPath);

      return {
        success: true,
        videoPath,
        filename: baseFilename,
        videoFilename,
        fileSize: st2.size,
      };
    } catch (err) {
      console.error('[Recording] Failed to ingest video:', err);
      return { success: false, error: err.message };
    }
  });

  // Copy an existing local video file into the recordings directory with a forced base filename.
  // Used for remote client mode so the client keeps a local copy with the final lecture_* name.
  ipcMain.handle('recording:ingestVideoAs', async (event, sourcePath, baseFilenameRaw) => {
    try {
      const src = String(sourcePath || '').trim();
      if (!src) return { success: false, error: 'Missing sourcePath' };

      const dir = await initRecordingsDir();
      const st = await fs.stat(src);
      if (!st.isFile()) return { success: false, error: 'Source is not a file' };

      const baseFilename = sanitizeBaseFilename(baseFilenameRaw);
      const ext = (path.extname(src) || '').toLowerCase() || '.mp4';

      let videoFilename = `${baseFilename}${ext}`;
      let videoPath = path.join(dir, videoFilename);

      // Ensure uniqueness (avoid collisions).
      for (let i = 0; i < 200; i++) {
        try {
          await fs.access(videoPath);
          videoFilename = `${baseFilename}_${i + 1}${ext}`;
          videoPath = path.join(dir, videoFilename);
        } catch {
          break;
        }
      }

      await fs.copyFile(src, videoPath);
      const st2 = await fs.stat(videoPath);

      return {
        success: true,
        videoPath,
        filename: videoFilename.replace(/\.(webm|mp4|mkv|mov|m4v|avi)$/i, ''),
        videoFilename,
        fileSize: st2.size,
      };
    } catch (err) {
      console.error('[Recording] Failed to ingest video (as):', err);
      return { success: false, error: err.message };
    }
  });

  // Save metadata for an already-present video file (no in-memory video transfer).
  ipcMain.handle('recording:saveExisting', async (event, videoPath, metadata) => {
    try {
      const dir = await initRecordingsDir();
      const vp = String(videoPath || '').trim();
      if (!vp) return { success: false, error: 'Missing videoPath' };

      const st = await fs.stat(vp);
      const fileSize = st.size;

      const rawName = path.basename(vp);
      const baseFilename = rawName.replace(/\.(webm|mp4|mkv|mov|m4v|avi)$/i, '');
      const metadataFilename = `${baseFilename}.json`;
      const metadataPath = path.join(dir, metadataFilename);

      const normalizeOrigin = (o) => {
        if (!o || typeof o !== 'object') return { kind: 'local' };
        const kind = o.kind === 'remote' ? 'remote' : 'local';
        const serverUrl = typeof o.serverUrl === 'string' ? o.serverUrl : undefined;
        const serverId = typeof o.serverId === 'string' ? o.serverId : undefined;
        return {
          kind,
          ...(serverUrl ? { serverUrl } : {}),
          ...(serverId ? { serverId } : {}),
        };
      };

      const fullMetadata = {
        ...metadata,
        origin: normalizeOrigin(metadata?.origin),
        videoFilename: rawName,
        videoPath: vp,
        savedAt: new Date().toISOString(),
        fileSize,
      };

      await fs.writeFile(metadataPath, JSON.stringify(fullMetadata, null, 2));
      console.log('[Recording] Metadata saved (existing video):', metadataPath);

      return { success: true, videoPath: vp, metadataPath, filename: baseFilename };
    } catch (err) {
      console.error('[Recording] Failed to save metadata for existing video:', err);
      return { success: false, error: err.message };
    }
  });

  // Write a raw video chunk into the recordings directory with a deterministic name.
  // Used by remote overlay mode to persist 3-minute transport chunks without saving metadata.
  ipcMain.handle('recording:writeChunk', async (_event, videoData, baseFilenameRaw, chunkIndexRaw, extRaw) => {
    try {
      const dir = await initRecordingsDir();
      const baseFilename = sanitizeBaseFilename(baseFilenameRaw);
      const chunkIndex = Number(chunkIndexRaw);
      if (!Number.isFinite(chunkIndex) || chunkIndex <= 0) {
        return { success: false, error: 'Invalid chunkIndex' };
      }

      const ext = String(extRaw || '.webm').toLowerCase().trim();
      const safeExt = /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '.webm';
      const padded = String(chunkIndex).padStart(4, '0');
      const videoFilename = `${baseFilename}_chunk_${padded}${safeExt}`;
      const videoPath = path.join(dir, videoFilename);

      let buf;
      if (videoData instanceof ArrayBuffer) {
        buf = Buffer.from(videoData);
      } else if (Buffer.isBuffer(videoData)) {
        buf = videoData;
      } else {
        return { success: false, error: 'Invalid videoData (expected ArrayBuffer)' };
      }

      await fs.writeFile(videoPath, buf);
      return { success: true, videoPath, videoFilename, fileSize: buf.length };
    } catch (err) {
      console.error('[Recording] Failed to write chunk:', err);
      return { success: false, error: err.message };
    }
  });

  // Write a manifest JSON file into recordings.
  ipcMain.handle('recording:writeManifest', async (_event, baseFilenameRaw, manifest) => {
    try {
      const dir = await initRecordingsDir();
      const baseFilename = sanitizeBaseFilename(baseFilenameRaw);
      const manifestFilename = `${baseFilename}_manifest.json`;
      const manifestPath = path.join(dir, manifestFilename);
      await fs.writeFile(manifestPath, JSON.stringify(manifest || {}, null, 2), 'utf8');
      return { success: true, manifestPath, manifestFilename };
    } catch (err) {
      console.error('[Recording] Failed to write manifest:', err);
      return { success: false, error: err.message };
    }
  });

  // Get video file path for streaming playback via the custom `video://` protocol.
  // This avoids loading large recordings into renderer memory.
  ipcMain.handle('recording:getVideoPath', async (event, videoFilename) => {
    try {
      const dir = await initRecordingsDir();
      const baseFilename = videoFilename.replace(/\.(webm|mp4|json)$/, '');

      const extensionsToTry = ['.mp4', '.webm'];
      let videoPath = '';
      let mimeType = 'video/webm';

      for (const ext of extensionsToTry) {
        const testPath = path.join(dir, `${baseFilename}${ext}`);
        try {
          await fs.access(testPath);
          videoPath = testPath;
          mimeType = ext === '.mp4' ? 'video/mp4' : 'video/webm';
          break;
        } catch {
          // try next
        }
      }

      if (!videoPath) {
        throw new Error(`Video file not found for ${baseFilename}`);
      }

      return { success: true, path: videoPath, mimeType };
    } catch (err) {
      console.error('[Recording] Failed to get video path:', err);
      return { success: false, error: err.message };
    }
  });

  console.log('[Recording] IPC handlers registered');
}

module.exports = { setupRecordingHandlers };
