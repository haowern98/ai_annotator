const {
  createOverlayWindow,
  closeOverlayWindow,
  getOverlayWindow,
  hasOverlayWindow,
} = require('../overlayWindow.cjs');

/**
 * Setup IPC handlers for overlay window management
 */
function setupOverlayHandlers(ipcMain) {
  // Create and show overlay window
  ipcMain.handle('overlay:create', async () => {
    try {
      const overlay = createOverlayWindow();
      return { success: true, windowId: overlay.id };
    } catch (error) {
      console.error('Error creating overlay window:', error);
      return { success: false, error: error.message };
    }
  });

  // Close overlay window
  ipcMain.handle('overlay:close', async () => {
    try {
      closeOverlayWindow();
      return { success: true };
    } catch (error) {
      console.error('Error closing overlay window:', error);
      return { success: false, error: error.message };
    }
  });

  // Update transcript in overlay
  ipcMain.handle('overlay:update-transcript', async (event, transcript) => {
    try {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('transcript-update', transcript);
        return { success: true };
      }
      return { success: false, error: 'Overlay window not found' };
    } catch (error) {
      console.error('Error updating transcript:', error);
      return { success: false, error: error.message };
    }
  });

  // Update AI reply in overlay
  ipcMain.handle('overlay:update-reply', async (event, reply) => {
    try {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('reply-update', reply);
        return { success: true };
      }
      return { success: false, error: 'Overlay window not found' };
    } catch (error) {
      console.error('Error updating reply:', error);
      return { success: false, error: error.message };
    }
  });

  // Handle control commands from overlay (pause/stop)
  ipcMain.handle('overlay:control', async (event, command) => {
    try {
      // Forward the control command to main window
      const mainWindow = require('electron').BrowserWindow.getAllWindows()
        .find(win => !win.skipTaskbar); // Find main window

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('overlay-control', command);
        return { success: true };
      }
      return { success: false, error: 'Main window not found' };
    } catch (error) {
      console.error('Error handling overlay control:', error);
      return { success: false, error: error.message };
    }
  });

  // Check if overlay exists
  ipcMain.handle('overlay:exists', async () => {
    return { exists: hasOverlayWindow() };
  });
}

module.exports = { setupOverlayHandlers };
