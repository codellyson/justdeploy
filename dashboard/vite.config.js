import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built assets are served by the JustDeploy dashboard server (src/dashboard.js) from
// dashboard/dist. In dev, proxy the API to a locally running dashboard server on :4999.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:4999', changeOrigin: true },
    },
  },
});
