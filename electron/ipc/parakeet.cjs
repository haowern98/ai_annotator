const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let parakeetProcess = null;
let isServerReady = false;

/**
 * Check if Parakeet server is healthy
 */
async function checkServerHealth() {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: 8765,
      path: '/health',
      method: 'GET',
      timeout: 2000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.status === 'healthy' && parsed.model_loaded === true);
        } catch {
          resolve(false);
        }
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

/**
 * Wait for server to become ready (with retry)
 * @param {number} maxAttempts - Maximum number of health check attempts
 * @param {number} delayMs - Delay between attempts in milliseconds
 * @param {Function} onProgress - Optional callback for progress updates (progress, status)
 */
async function waitForServerReady(maxAttempts = 120, delayMs = 1000, onProgress = null) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[Parakeet IPC] Checking server health (attempt ${attempt}/${maxAttempts})...`);
    
    // Calculate progress percentage
    const progress = (attempt / maxAttempts) * 100;
    
    // Determine status message based on progress
    let status = 'Initializing transcription engine...';
    if (progress > 20 && progress <= 50) {
      status = 'Loading AI model...';
    } else if (progress > 50 && progress <= 80) {
      status = 'Preparing transcription service...';
    } else if (progress > 80) {
      status = 'Almost ready...';
    }
    
    // Send progress update
    if (onProgress) {
      onProgress(progress, status);
    }
    
    const healthy = await checkServerHealth();
    if (healthy) {
      console.log('[Parakeet IPC] ✓ Server is ready');
      if (onProgress) {
        onProgress(100, 'Ready!');
      }
      return true;
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

/**
 * Initialize Parakeet Python server
 * @param {Function} onProgress - Optional callback for progress updates (progress, status)
 */
async function initializeParakeet(onProgress = null) {
  if (parakeetProcess !== null) {
    console.log('[Parakeet IPC] Server already running');
    
    // Check if it's still healthy
    const healthy = await checkServerHealth();
    if (healthy) {
      if (onProgress) {
        onProgress(100, 'Already running');
      }
      return { success: true, alreadyRunning: true };
    } else {
      console.log('[Parakeet IPC] Existing server not responding, restarting...');
      await disposeParakeet();
    }
  }

  try {
    console.log('[Parakeet IPC] Starting Parakeet Python server...');
    
    if (onProgress) {
      onProgress(5, 'Starting Python server...');
    }

    // Path to Python server script
    const pythonServerPath = path.join(__dirname, '..', '..', 'python-server', 'parakeet_server.py');
    
    // Use Python from venv if available, otherwise system Python
    const venvPythonPath = path.join(__dirname, '..', 'python-env', 'venv', 'Scripts', 'python.exe');
    const fs = require('fs');
    const pythonExecutable = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';

    console.log(`[Parakeet IPC] Using Python: ${pythonExecutable}`);
    console.log(`[Parakeet IPC] Script path: ${pythonServerPath}`);

    // Spawn Python process
    parakeetProcess = spawn(pythonExecutable, [pythonServerPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true
    });

    // Handle stdout
    parakeetProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[Parakeet Server] ${output}`);
      }
    });

    // Handle stderr
    parakeetProcess.stderr.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[Parakeet Server Error] ${output}`);
      }
    });

    // Handle process exit
    parakeetProcess.on('exit', (code, signal) => {
      console.log(`[Parakeet IPC] Server process exited (code: ${code}, signal: ${signal})`);
      parakeetProcess = null;
      isServerReady = false;
    });

    // Handle process error
    parakeetProcess.on('error', (error) => {
      console.error(`[Parakeet IPC] Process error: ${error.message}`);
      parakeetProcess = null;
      isServerReady = false;
    });

    // Wait for server to become ready
    console.log('[Parakeet IPC] Waiting for server to become ready...');
    if (onProgress) {
      onProgress(10, 'Waiting for server initialization...');
    }
    
    const ready = await waitForServerReady(120, 1000, onProgress);

    if (!ready) {
      throw new Error('Server failed to become ready within timeout');
    }

    isServerReady = true;
    console.log('[Parakeet IPC] ✓ Parakeet server initialized successfully');

    return { success: true };
  } catch (error) {
    console.error(`[Parakeet IPC] ❌ Failed to initialize: ${error.message}`);
    
    // Cleanup on failure
    if (parakeetProcess) {
      try {
        parakeetProcess.kill();
      } catch {}
      parakeetProcess = null;
    }

    return { success: false, error: error.message };
  }
}

/**
 * Dispose Parakeet server
 */
async function disposeParakeet() {
  if (parakeetProcess) {
    console.log('[Parakeet IPC] Stopping Parakeet server...');
    
    try {
      // Try graceful shutdown first
      parakeetProcess.kill('SIGTERM');
      
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Force kill if still running
      if (parakeetProcess && !parakeetProcess.killed) {
        console.log('[Parakeet IPC] Force killing server...');
        parakeetProcess.kill('SIGKILL');
      }
    } catch (error) {
      console.error(`[Parakeet IPC] Error stopping server: ${error.message}`);
    }
    
    parakeetProcess = null;
    isServerReady = false;
    console.log('[Parakeet IPC] ✓ Server stopped');
  }

  return { success: true };
}

/**
 * Setup Parakeet IPC handlers
 */
function setupParakeetHandlers(ipcMain) {
  console.log('[Parakeet IPC] Setting up handlers...');

  // Initialize Parakeet server
  ipcMain.handle('parakeet:initialize', async (event) => {
    return await initializeParakeet();
  });

  // Dispose Parakeet server
  ipcMain.handle('parakeet:dispose', async (event) => {
    return await disposeParakeet();
  });

  // Check server health
  ipcMain.handle('parakeet:health', async (event) => {
    const healthy = await checkServerHealth();
    return { success: true, healthy, isRunning: parakeetProcess !== null };
  });

  console.log('[Parakeet IPC] ✓ Handlers registered');
}

module.exports = { setupParakeetHandlers, initializeParakeet };
