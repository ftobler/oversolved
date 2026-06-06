import path from 'path'
import { defineConfig } from 'vitest/config'

// Dedicated config for the full-document parity gate (WASM migration phase 4b).
// This is the enforced "old kernel == new kernel" gate: it is slow, needs OCC.js
// provisioned (`npm run occ:install`), and hard-fails on any divergence. It is
// deliberately split out of the default `vitest run` (see vitest.config.ts
// exclude) so `just frontend` stays fast and decoupled. Run via `just parity`.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    include: ['src/kernel/occ/fullDocParity.test.ts'],
  },
})
