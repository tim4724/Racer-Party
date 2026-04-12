import { defineConfig } from 'vite';
import { resolve } from 'path';

// Multi-page Vite build: display at /, controller at /controller/
// In dev, the Bun server proxies non-API requests to Vite at $VITE_PORT.
export default defineConfig({
  root: resolve(__dirname, 'src'),
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@display': resolve(__dirname, 'src/display'),
      '@controller': resolve(__dirname, 'src/controller'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        display: resolve(__dirname, 'src/display/index.html'),
        controller: resolve(__dirname, 'src/controller/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // The page is served by the Bun proxy at :4000, but Vite's HMR client
    // needs a direct WebSocket to Vite. Send the client to :5173 explicitly
    // so HMR works without proxying WebSocket upgrades through Bun.
    hmr: {
      host: 'localhost',
      protocol: 'ws',
      clientPort: 5173,
    },
  },
  optimizeDeps: {
    // Rapier ships a sync WASM that needs to be excluded from pre-bundling
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
