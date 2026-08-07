import path from 'path'
import { defineConfig } from 'vitest/config'

// Dedicated config for the full-document parity gate. This is a post-migration
// regression gate (live TS/WASM kernel == frozen golden baseline): it is slow,
// needs OCC.js provisioned (`npm run occ:install`), and hard-fails on any
// divergence. It is deliberately split out of the default `vitest run` (see
// vitest.config.ts exclude) so `just frontend` stays fast and decoupled. Run via
// `just parity`.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    include: ['src/kernel/occ/fullDocParity.test.ts'],
    // Heavy gate (OCC.js download + WASM compile in hooks) on a contended box.
    // The first test pays the cold start (fork child + load OCC.js + compile
    // WASM) and solveWithTimeout already guards each solve at 30s, so a vitest
    // timeout below that buys nothing and just flakes. Generous in both CI and
    // local.
    testTimeout: 60000,
    hookTimeout: 120000,
  },
})
