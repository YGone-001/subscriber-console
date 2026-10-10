import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Vite proxy is a development transport only. It is not API ownership and is not part of the production target topology.
// Development bind is 0.0.0.0 so a same-subnet client can reach the dev server on the
// host LAN address. Go stays on loopback and is still only reachable through this proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 13333,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:18888',
        changeOrigin: false,
      },
    },
  },
});
