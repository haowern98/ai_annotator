import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');

    return {
      plugins: [],
      server: {
        host: '0.0.0.0',
        port: 5173,
        watch: {
          ignored: ['**/.recordings/**'],
        },
      },
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      base: './', // Important for Electron to load files correctly
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            overlay: path.resolve(__dirname, 'overlay.html'),
            'lecture-overlay': path.resolve(__dirname, 'lecture-overlay.html'),
          },
        },
      },
    };
});
