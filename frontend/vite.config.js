import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to the backend during development
      '/incidents': { target: 'http://localhost:3001', changeOrigin: true },
      '/reports':   { target: 'http://localhost:3001', changeOrigin: true },
      '/status':    { target: 'http://localhost:3001', changeOrigin: true },
      '/health':    { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
