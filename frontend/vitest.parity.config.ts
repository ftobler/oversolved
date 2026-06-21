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
    // Heavy gate (OCC.js download + WASM compile in hooks) on a contended CI
    // box. Generous timeouts in CI only; local keeps vitest defaults.
    testTimeout: process.env.CI ? 60000 : undefined,
    hookTimeout: process.env.CI ? 120000 : undefined,
  },
})
