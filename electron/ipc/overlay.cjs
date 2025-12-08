const {
  createOverlayWindow,
  closeOverlayWindow,
  getOverlayWindow,
  hasOverlayWindow,
} = require('../overlayWindow.cjs');

// Store reference to main window getter
let mainWindowGetter = null;

/**
 * Setup IPC handlers for overlay window management
 * @param {Object} ipcMain - Electron IPC main module
 * @param {Function} getMainWindow - Optional function to get main window reference
 */
function setupOverlayHandlers(ipcMain, getMainWindow) {
  // Store the getter for later use
  if (getMainWindow) {
    mainWindowGetter = getMainWindow;
  }
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
      // Get main window using the stored getter, or fall back to finding it
      let mainWindow = mainWindowGetter ? mainWindowGetter() : null;
      
      // Fallback: find main window by searching all windows
      if (!mainWindow) {
        const { BrowserWindow } = require('electron');
        const allWindows = BrowserWindow.getAllWindows();
        mainWindow = allWindows.find(win => {
          try {
            return !win.isDestroyed() && win.getTitle() !== 'LLS Overlay';
          } catch (e) {
            return false;
          }
        });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Overlay IPC] Forwarding control command to main window:', command);
        mainWindow.webContents.send('overlay-control', command);
        return { success: true };
      }
      console.error('[Overlay IPC] Main window not found');
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

  // Show the overlay window
  ipcMain.handle('overlay:show', async () => {
    try {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.show();
        overlay.focus();
        return { success: true };
      }
      return { success: false, error: 'Overlay window not found' };
    } catch (error) {
      console.error('Error showing overlay:', error);
      return { success: false, error: error.message };
    }
  });

  // Hide the overlay window
  ipcMain.handle('overlay:hide', async () => {
    try {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.hide();
        return { success: true };
      }
      return { success: false, error: 'Overlay window not found' };
    } catch (error) {
      console.error('Error hiding overlay:', error);
      return { success: false, error: error.message };
    }
  });

  // Resize overlay window (width and/or height)
  ipcMain.handle('overlay:resize', async (event, dimensions) => {
    try {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        const [currentWidth, currentHeight] = overlay.getSize();
        const newWidth = dimensions.width ? Math.round(dimensions.width) : currentWidth;
        const newHeight = dimensions.height ? Math.round(dimensions.height) : currentHeight;
        
        // Use setBounds to force resize (fixes shrinking issue on Windows with transparent windows)
        const bounds = overlay.getBounds();
        overlay.setBounds({
          x: bounds.x,
          y: bounds.y,
          width: newWidth,
          height: newHeight
        });
        
        console.log('[Overlay IPC] Resized window to:', newWidth, 'x', newHeight);
        return { success: true };
      }
      return { success: false, error: 'Overlay window not found' };
    } catch (error) {
      console.error('Error resizing overlay:', error);
      return { success: false, error: error.message };
    }
  });

  // Start screen analysis service
  ipcMain.handle('analysis:start', async () => {
    try {
      let mainWindow = mainWindowGetter ? mainWindowGetter() : null;
      
      if (!mainWindow) {
        const { BrowserWindow } = require('electron');
        const allWindows = BrowserWindow.getAllWindows();
        mainWindow = allWindows.find(win => {
          try {
            return !win.isDestroyed() && win.getTitle() !== 'LLS Overlay';
          } catch (e) {
            return false;
          }
        });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Overlay IPC] Starting screen analysis service');
        mainWindow.webContents.send('analysis-control', 'start');
        return { success: true };
      }
      return { success: false, error: 'Main window not found' };
    } catch (error) {
      console.error('Error starting analysis:', error);
      return { success: false, error: error.message };
    }
  });

  // Stop screen analysis service
  ipcMain.handle('analysis:stop', async () => {
    try {
      let mainWindow = mainWindowGetter ? mainWindowGetter() : null;
      
      if (!mainWindow) {
        const { BrowserWindow } = require('electron');
        const allWindows = BrowserWindow.getAllWindows();
        mainWindow = allWindows.find(win => {
          try {
            return !win.isDestroyed() && win.getTitle() !== 'LLS Overlay';
          } catch (e) {
            return false;
          }
        });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Overlay IPC] Stopping screen analysis service');
        mainWindow.webContents.send('analysis-control', 'stop');
        return { success: true };
      }
      return { success: false, error: 'Main window not found' };
    } catch (error) {
      console.error('Error stopping analysis:', error);
      return { success: false, error: error.message };
    }
  });

  // Generate analysis reply
  ipcMain.handle('analysis:generate', async () => {
    try {
      let mainWindow = mainWindowGetter ? mainWindowGetter() : null;
      
      if (!mainWindow) {
        const { BrowserWindow } = require('electron');
        const allWindows = BrowserWindow.getAllWindows();
        mainWindow = allWindows.find(win => {
          try {
            return !win.isDestroyed() && win.getTitle() !== 'LLS Overlay';
          } catch (e) {
            return false;
          }
        });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Overlay IPC] Generating analysis reply');
        mainWindow.webContents.send('analysis-control', 'generate');
        return { success: true };
      }
      return { success: false, error: 'Main window not found' };
    } catch (error) {
      console.error('Error generating analysis:', error);
      return { success: false, error: error.message };
    }
  });

  // Update analysis in overlay
  ipcMain.handle('overlay:update-analysis', async (event, analysis) => {
    try {
      const overlay = getOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('analysis-update', analysis);
        return { success: true };
      }
      return { success: false, error: 'Overlay window not found' };
    } catch (error) {
      console.error('Error updating analysis:', error);
      return { success: false, error: error.message };
    }
  });

  // Send user question to analysis service
  ipcMain.handle('analysis:question', async (event, question) => {
    try {
      let mainWindow = mainWindowGetter ? mainWindowGetter() : null;
      
      if (!mainWindow) {
        const { BrowserWindow } = require('electron');
        const allWindows = BrowserWindow.getAllWindows();
        mainWindow = allWindows.find(win => {
          try {
            return !win.isDestroyed() && win.getTitle() !== 'LLS Overlay';
          } catch (e) {
            return false;
          }
        });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Overlay IPC] Sending analysis question:', question.substring(0, 50) + '...');
        mainWindow.webContents.send('analysis-control', { command: 'question', text: question });
        return { success: true };
      }
      return { success: false, error: 'Main window not found' };
    } catch (error) {
      console.error('Error sending analysis question:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { setupOverlayHandlers };
