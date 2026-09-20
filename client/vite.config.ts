import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
      },
      '/drive': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      // Runtime STUN/TURN config.
      '/ice': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    // Maps ship to production hosts otherwise (adds ~5 MB per deploy);
    // vite build --sourcemap re-enables them for debugging sessions.
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // Heavy media engines load on demand; keep the core bundle lean.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
