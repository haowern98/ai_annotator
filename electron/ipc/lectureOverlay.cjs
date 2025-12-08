const {
  createLectureOverlayWindow,
  closeLectureOverlayWindow,
  getLectureOverlayWindow,
  hasLectureOverlayWindow,
  resizeLectureOverlayWindow,
  sendToLectureOverlay,
} = require('../lectureOverlayWindow.cjs');

// Store reference to main window getter
let mainWindowGetter = null;

/**
 * Setup IPC handlers for lecture overlay window management
 * @param {Object} ipcMain - Electron IPC main module
 * @param {Function} getMainWindow - Optional function to get main window reference
 */
function setupLectureOverlayHandlers(ipcMain, getMainWindow) {
  if (getMainWindow) {
    mainWindowGetter = getMainWindow;
  }

  // Create and show lecture overlay window
  ipcMain.handle('lecture-overlay:create', async () => {
    try {
      const overlay = createLectureOverlayWindow();
      return { success: true, windowId: overlay.id };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error creating window:', error);
      return { success: false, error: error.message };
    }
  });

  // Close lecture overlay window
  ipcMain.handle('lecture-overlay:close', async () => {
    try {
      closeLectureOverlayWindow();
      return { success: true };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error closing window:', error);
      return { success: false, error: error.message };
    }
  });

  // Check if lecture overlay exists
  ipcMain.handle('lecture-overlay:exists', async () => {
    return { exists: hasLectureOverlayWindow() };
  });

  // Show the lecture overlay window
  ipcMain.handle('lecture-overlay:show', async () => {
    try {
      const overlay = getLectureOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.show();
        overlay.focus();
        return { success: true };
      }
      return { success: false, error: 'Lecture overlay window not found' };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error showing window:', error);
      return { success: false, error: error.message };
    }
  });

  // Hide the lecture overlay window
  ipcMain.handle('lecture-overlay:hide', async () => {
    try {
      const overlay = getLectureOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.hide();
        return { success: true };
      }
      return { success: false, error: 'Lecture overlay window not found' };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error hiding window:', error);
      return { success: false, error: error.message };
    }
  });

  // Resize lecture overlay window
  ipcMain.handle('lecture-overlay:resize', async (event, dimensions) => {
    try {
      const overlay = getLectureOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        const [currentWidth, currentHeight] = overlay.getSize();
        const newWidth = dimensions.width ? Math.round(dimensions.width) : currentWidth;
        const newHeight = dimensions.height ? Math.round(dimensions.height) : currentHeight;
        
        const bounds = overlay.getBounds();
        overlay.setBounds({
          x: bounds.x,
          y: bounds.y,
          width: newWidth,
          height: newHeight,
        });
        
        console.log('[LectureOverlay IPC] Resized window to:', newWidth, 'x', newHeight);
        return { success: true };
      }
      return { success: false, error: 'Lecture overlay window not found' };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error resizing window:', error);
      return { success: false, error: error.message };
    }
  });

  // Handle control commands from lecture overlay (pause/resume/stop/generate-summary)
  ipcMain.handle('lecture-overlay:control', async (event, command) => {
    try {
      let mainWindow = mainWindowGetter ? mainWindowGetter() : null;
      
      if (!mainWindow) {
        const { BrowserWindow } = require('electron');
        const allWindows = BrowserWindow.getAllWindows();
        mainWindow = allWindows.find(win => {
          try {
            return !win.isDestroyed() && 
              win.getTitle() !== 'LLS Overlay' && 
              win.getTitle() !== 'LLS Lecture Overlay';
          } catch (e) {
            return false;
          }
        });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[LectureOverlay IPC] Forwarding control command:', command);
        mainWindow.webContents.send('lecture-control', command);
        return { success: true };
      }
      console.error('[LectureOverlay IPC] Main window not found');
      return { success: false, error: 'Main window not found' };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error handling control:', error);
      return { success: false, error: error.message };
    }
  });

  // Update transcript in lecture overlay
  ipcMain.handle('lecture-overlay:update-transcript', async (event, data) => {
    try {
      const overlay = getLectureOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('lecture-transcript-update', data);
        return { success: true };
      }
      return { success: false, error: 'Lecture overlay window not found' };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error updating transcript:', error);
      return { success: false, error: error.message };
    }
  });

  // Update summary in lecture overlay
  ipcMain.handle('lecture-overlay:update-summary', async (event, data) => {
    try {
      const overlay = getLectureOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('lecture-summary-update', data);
        return { success: true };
      }
      return { success: false, error: 'Lecture overlay window not found' };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error updating summary:', error);
      return { success: false, error: error.message };
    }
  });

  // Update status in lecture overlay
  ipcMain.handle('lecture-overlay:update-status', async (event, data) => {
    try {
      const overlay = getLectureOverlayWindow();
      if (overlay && !overlay.isDestroyed()) {
        overlay.webContents.send('lecture-status-update', data);
        return { success: true };
      }
      return { success: false, error: 'Lecture overlay window not found' };
    } catch (error) {
      console.error('[LectureOverlay IPC] Error updating status:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { setupLectureOverlayHandlers };
