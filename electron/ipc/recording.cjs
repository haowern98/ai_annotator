const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;

let recordingsDir = null;

// Initialize recordings directory
async function initRecordingsDir() {
  if (recordingsDir) return recordingsDir;
  
  // Use hardcoded path for now (will be configurable in settings later)
  recordingsDir = path.join('E:', 'live-lecture-summarizer correct', 'recordings');
  
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

      // Add file info to metadata
      const fullMetadata = {
        ...metadata,
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
      const metadataFiles = files.filter(f => f.endsWith('.json'));
      
      const recordings = await Promise.all(
        metadataFiles.map(async (filename) => {
          try {
            const metadataPath = path.join(dir, filename);
            const content = await fs.readFile(metadataPath, 'utf8');
            return JSON.parse(content);
          } catch (err) {
            console.error('[Recording] Failed to read metadata:', filename, err);
            return null;
          }
        })
      );

      // Filter out failed reads and sort by date (newest first)
      const validRecordings = recordings
        .filter(r => r !== null)
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

      return { success: true, metadata };
    } catch (err) {
      console.error('[Recording] Failed to read metadata:', err);
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

  console.log('[Recording] IPC handlers registered');
}

module.exports = { setupRecordingHandlers };
