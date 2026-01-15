const { ipcMain } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

/**
 * Setup IPC handlers for keyframe extraction workflow.
 * Handles saving video blobs to temp files for keyframe_worker processing.
 */
function setupKeyframeHandlers(ipcMain) {
  /**
   * Save video blob to temporary file and return path.
   * Used by lectureDualSessionManager to pass video to keyframe_worker.
   */
  ipcMain.handle('keyframe:saveTempVideo', async (event, videoDataBuffer, mimeType) => {
    try {
      // Determine file extension from MIME type
      let extension = 'webm';
      if (mimeType && mimeType.includes('mp4')) {
        extension = 'mp4';
      } else if (mimeType && mimeType.includes('webm')) {
        extension = 'webm';
      }

      // Generate unique filename
      const filename = `lecture_segment_${uuidv4()}.${extension}`;
      const tempDir = os.tmpdir();
      const tempPath = path.join(tempDir, filename);

      // Convert ArrayBuffer to Buffer if needed
      let buffer;
      if (Buffer.isBuffer(videoDataBuffer)) {
        buffer = videoDataBuffer;
      } else if (videoDataBuffer instanceof ArrayBuffer) {
        buffer = Buffer.from(videoDataBuffer);
      } else if (typeof videoDataBuffer === 'string') {
        // Base64 string
        buffer = Buffer.from(videoDataBuffer, 'base64');
      } else {
        throw new Error('Invalid video data format');
      }

      // Write to temp file with explicit flush
      await fs.writeFile(tempPath, buffer, { flush: true });
      
      // CRITICAL: Wait and verify file is readable before returning
      // Windows issue: file handle might not be released immediately
      let retries = 0;
      const maxRetries = 5;
      
      while (retries < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 300));
        
        try {
          // Try to open and read first few bytes to verify file is valid
          const testHandle = await fs.open(tempPath, 'r');
          const testBuffer = Buffer.allocUnsafe(512);
          await testHandle.read(testBuffer, 0, 512, 0);
          await testHandle.close();
          
          // Verify WebM signature (0x1A 0x45 0xDF 0xA3 = EBML header)
          if (testBuffer[0] === 0x1A && testBuffer[1] === 0x45 && testBuffer[2] === 0xDF && testBuffer[3] === 0xA3) {
            console.log(`[KeyframeIPC] File verified readable after ${retries + 1} attempts`);
            break;
          } else {
            console.warn(`[KeyframeIPC] WebM header invalid, retry ${retries + 1}/${maxRetries}`);
          }
        } catch (err) {
          console.warn(`[KeyframeIPC] File not readable yet, retry ${retries + 1}/${maxRetries}: ${err.message}`);
        }
        
        retries++;
      }
      
      if (retries >= maxRetries) {
        throw new Error('File verification failed after 5 attempts - file may be corrupted');
      }

      console.log(`[KeyframeIPC] Saved temp video: ${tempPath} (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`);

      return {
        success: true,
        path: tempPath,
        size: buffer.length,
      };
    } catch (err) {
      console.error('[KeyframeIPC] Failed to save temp video:', err);
      return {
        success: false,
        error: err.message,
      };
    }
  });

  /**
   * Clean up temporary video file after keyframe extraction.
   */
  ipcMain.handle('keyframe:cleanupTempVideo', async (event, tempPath) => {
    try {
      if (!tempPath) {
        return { success: false, error: 'No path provided' };
      }

      // Verify path is in temp directory (security check)
      const tempDir = os.tmpdir();
      const normalizedPath = path.normalize(tempPath);
      const normalizedTemp = path.normalize(tempDir);

      if (!normalizedPath.startsWith(normalizedTemp)) {
        throw new Error('Path is not in temp directory');
      }

      // Check if file exists
      try {
        await fs.access(tempPath);
      } catch {
        // File doesn't exist, consider it cleaned
        return { success: true };
      }

      // Delete file
      await fs.unlink(tempPath);

      console.log(`[KeyframeIPC] Cleaned up temp video: ${tempPath}`);

      return { success: true };
    } catch (err) {
      console.error('[KeyframeIPC] Failed to cleanup temp video:', err);
      return {
        success: false,
        error: err.message,
      };
    }
  });

  console.log('[KeyframeIPC] Handlers registered');
}

module.exports = { setupKeyframeHandlers };
