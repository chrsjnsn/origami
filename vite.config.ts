import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Hashed bundles go to dist/static so they never mix with the canonical files in public/assets.
    assetsDir: 'static',
    // One page, one bundle: three.js is most of it (about 240 kB gzipped in total).
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
