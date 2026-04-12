import { defineConfig } from 'vite';
import { resolve } from 'path';

// Build-only config. In dev the Bun server creates Vite programmatically
// in middleware mode (see server/index.ts), passing this config file.
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
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
