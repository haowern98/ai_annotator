const os = require('os');

/**
 * Setup network detection IPC handlers
 * @param {Electron.IpcMain} ipcMain
 */
function setupNetworkHandlers(ipcMain) {
  // Get local IP address
  ipcMain.handle('network:get-local-ip', () => {
    try {
      const interfaces = os.networkInterfaces();
      
      // Prefer IPv4 non-internal addresses
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          // Skip internal (loopback) and IPv6
          if (iface.family === 'IPv4' && !iface.internal) {
            console.log('[Network] Local IP:', iface.address);
            return { success: true, ip: iface.address };
          }
        }
      }
      
      return { success: false, error: 'No network interface found' };
    } catch (error) {
      console.error('[Network] Failed to get local IP:', error);
      return { success: false, error: error.message };
    }
  });

  // Get public IP address
  ipcMain.handle('network:get-public-ip', async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch('https://api.ipify.org?format=json', { 
        signal: controller.signal 
      });
      clearTimeout(timeoutId);
      
      const data = await response.json();
      console.log('[Network] Public IP:', data.ip);
      return { success: true, ip: data.ip };
    } catch (error) {
      console.error('[Network] Failed to get public IP:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { setupNetworkHandlers };
