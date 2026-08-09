import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Platform version, read from the ROOT package.json (not src/dashboard's) —
// that is the one `getPlatformVersion()` serves from /api/v1/health, so the
// UI and the API report the same string. Injected rather than hardcoded in a
// component: three components carried a literal and all three still read
// v2.0.0-rc.1 two releases later.
const platformVersion = (
  JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
  ) as { version: string }
).version;

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  define: {
    __DROP_VERSION__: JSON.stringify(platformVersion),
  },
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
