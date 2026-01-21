const path = require('path');
const { spawn } = require('child_process');

/**
 * Setup Qwen control IPC handlers
 * @param {Electron.IpcMain} ipcMain
 * @param {Function} getVenvPythonPath 
 * @param {Function} fetchJsonWithTimeout 
 * @param {Function} getQwenProcess - Get the main qwenProcess from main.cjs
 * @param {Function} setQwenProcess - Set the main qwenProcess in main.cjs
 */
function setupQwenControlHandlers(ipcMain, getVenvPythonPath, fetchJsonWithTimeout, getQwenProcess, setQwenProcess) {
  // Start Qwen in remote mode (0.0.0.0)
  ipcMain.handle('qwen:start-remote', async () => {
    try {
      // Stop existing Qwen process from app startup
      const existingProcess = getQwenProcess();
      if (existingProcess && !existingProcess.killed) {
        console.log('[Qwen] Stopping startup process (127.0.0.1) for remote mode (0.0.0.0)...');
        existingProcess.kill();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for cleanup
      }

      const qwenPort = String(process.env.QWEN_PORT || '7556');
      const pythonCmd = getVenvPythonPath();

      console.log('[Qwen] Starting in remote mode (0.0.0.0)...');
      
      const newProcess = spawn(
        pythonCmd,
        ['-m', 'uvicorn', 'server:app', '--host', '0.0.0.0', '--port', qwenPort, '--log-level', 'info'],
        {
          cwd: path.join(__dirname, '..', '..', 'qwen_worker'),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, QWEN_HOST: '0.0.0.0', QWEN_PORT: qwenPort },
        }
      );

      // Update main.cjs qwenProcess reference
      setQwenProcess(newProcess);

      newProcess.stdout?.on('data', (buf) => {
        const chunk = String(buf);
        chunk.split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[QwenWorker] ${l}`));
      });

      newProcess.stderr?.on('data', (buf) => {
        const chunk = String(buf);
        chunk.split(/\r?\n/).filter(Boolean).forEach((l) => console.warn(`[QwenWorker] ${l}`));
      });

      // Wait for health check
      const baseUrl = `http://127.0.0.1:${qwenPort}`;
      const healthUrl = `${baseUrl}/health`;
      const startedAt = Date.now();
      const timeoutMs = 60000; // 1 minute for restart

      while (Date.now() - startedAt < timeoutMs) {
        try {
          const json = await fetchJsonWithTimeout(healthUrl, 1000);
          if (json?.status === 'healthy') {
            console.log('[Qwen] Remote mode ready');
            return { success: true };
          }
        } catch {
          // Not ready yet
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return { success: false, error: 'Qwen failed to start in remote mode (timeout)' };
    } catch (error) {
      console.error('[Qwen] Failed to start remote mode:', error);
      return { success: false, error: error.message };
    }
  });

  // Stop Qwen process
  ipcMain.handle('qwen:stop', async () => {
    try {
      const existingProcess = getQwenProcess();
      if (existingProcess && !existingProcess.killed) {
        console.log('[Qwen] Stopping process...');
        existingProcess.kill();
        setQwenProcess(null);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return { success: true };
      }
      return { success: true, message: 'Qwen not running' };
    } catch (error) {
      console.error('[Qwen] Failed to stop:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { setupQwenControlHandlers };
