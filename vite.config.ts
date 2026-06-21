import { defineConfig } from 'vite';

export default defineConfig({
  base: '/KB1-studio/', // GitHub Pages base URL
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5174,
    open: true,
  },
});
