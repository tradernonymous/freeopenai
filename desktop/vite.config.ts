import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: 'public',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // ../shared holds modules the web app loads too (docs/adr/0002).
    fs: { allow: ['.', '../shared'] },
  },
  build: {
    outDir: 'dist',
  },
});
