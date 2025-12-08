/**
 * Screen Capture IPC Handlers
 * Provides Electron's desktopCapturer API to the renderer process
 */

function setupScreenCaptureHandlers(ipcMain, desktopCapturer) {
  // Get available screen sources
  ipcMain.handle('get-screen-sources', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 800, height: 600 },
        fetchWindowIcons: true,
      });

      // Filter out our overlay window(s) so they don't appear in share pickers
      const filtered = sources.filter((source) => {
        try {
          // DesktopCapturer source.name typically matches the window title for 'window' types
          if (typeof source.name === 'string' && source.name.includes('LLS Overlay')) {
            return false;
          }
        } catch (e) {
          // If any check fails, keep the source to avoid hiding legitimate entries
          console.warn('Error checking source for overlay marker:', e);
        }
        return true;
      });

      // Return serializable data
      return filtered.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
        appIcon: source.appIcon ? source.appIcon.toDataURL() : null,
        display_id: source.display_id,
      }));
    } catch (error) {
      console.error('Error getting screen sources:', error);
      throw error;
    }
  });

  // Get stream ID for a specific source
  // Note: The actual MediaStream creation happens in the renderer
  // This just validates the source ID
  ipcMain.handle('get-screen-stream', async (event, sourceId) => {
    try {
      // Return the source ID that will be used in the renderer
      // The renderer will use navigator.mediaDevices.getUserMedia with
      // chromeMediaSourceId constraint
      return {
        sourceId,
        success: true,
      };
    } catch (error) {
      console.error('Error validating screen stream:', error);
      throw error;
    }
  });

  // Handle environment variables securely
  ipcMain.on('get-env', (event, key) => {
    // Only allow specific environment variables
    const allowedKeys = ['GEMINI_API_KEY', 'NODE_ENV'];

    if (allowedKeys.includes(key)) {
      event.returnValue = process.env[key] || null;
    } else {
      event.returnValue = null;
    }
  });
}

module.exports = { setupScreenCaptureHandlers };
