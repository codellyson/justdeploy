import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built assets are served by the JustDeploy dashboard server (src/dashboard.js) from
// dashboard/dist. In dev, proxy /api to a running dashboard server so `pnpm dev` iterates
// on the UI against a real backend, no deploy needed. The backend only binds 127.0.0.1:4999
// on the VPS (behind Caddy), so tunnel it to your machine and let the default target hit it:
//   ssh -p 22022 -N -L 4999:127.0.0.1:4999 root@104.207.81.163
// Override the target only if the backend lives elsewhere: VITE_API_TARGET=... pnpm dev
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4999';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // Rebind session cookies to localhost so the browser stores/sends them, and
        // don't buffer the SSE build/runtime log streams.
        cookieDomainRewrite: '',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.accept === 'text/event-stream') proxyReq.setHeader('accept-encoding', 'identity');
          });
        },
      },
    },
  },
});
