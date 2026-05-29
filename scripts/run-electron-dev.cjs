const { spawn } = require('child_process');

delete process.env.ELECTRON_RUN_AS_NODE;
process.env.NODE_ENV = 'development';

const electronPath = require('electron');
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[run-electron-dev] Failed to start Electron:', err);
  process.exit(1);
});

