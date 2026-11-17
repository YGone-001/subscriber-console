import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Vite proxy is a development transport only. It is not API ownership and is not part of the production target topology.
// Development bind is 0.0.0.0 so a same-subnet client can reach the dev server on the
// host LAN address. Go stays on loopback and is still only reachable through this proxy.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        /*
         * Route-level lazy loading gives every business page its own chunk.
         * Rolldown then also extracts every module two pages share, and with
         * lucide-react that meant one chunk per icon (52 chunks below 1 KiB in
         * a 140 chunk build). The production edge is HTTP/1.1, so each of those
         * chunks costs a round trip on first navigation.
         *
         * One narrow group consolidates the icon set: 107 chunks instead of 140,
         * 14-23 requests per first navigation instead of 22-28, zero duplicated
         * modules, and total JavaScript slightly smaller. The entry grows by
         * ~23 KiB raw (~8 KiB gzip) because the shell already needs icons.
         *
         * Everything else keeps the default dependency graph: broader groups and
         * inlining common chunks were both measured and both lost (entry bloat
         * and 151 duplicated modules respectively).
         */
        codeSplitting: {
          includeDependenciesRecursively: false,
          groups: [
            { name: 'vendor-icons', test: /[\\/]node_modules[\\/]lucide-react[\\/]/, priority: 30 },
          ],
        },
      },
    },
  },
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
