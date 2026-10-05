import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Vite proxy is a development transport only. It is not API ownership and is not part of the production target topology.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
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
