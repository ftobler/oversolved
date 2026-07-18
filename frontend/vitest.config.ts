import path from 'path'
import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

// CI runs on a contended self-hosted box (6 runners + a high-priority devbox on
// 8 cores), so tests are far slower than wall-clock under load. Bump timeouts in
// CI only; local keeps the snappy vitest defaults for fast feedback.
const ci = !!process.env.CI

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The full-document parity gate is slow, needs OCC.js provisioned, and
    // hard-fails on any kernel divergence. It runs via its own config
    // (`just parity` / vitest.parity.config.ts), not the fast default suite.
    exclude: [...configDefaults.exclude, 'src/kernel/occ/fullDocParity.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: ci ? 60000 : undefined,
    hookTimeout: ci ? 120000 : undefined,
    // Vitest sizes the fork pool by core count. The `*Real.test.ts` files each
    // instantiate their own OCC WASM kernel, so on a many-core box the pool
    // outruns RAM: a worker gets OOM-killed mid-run and the suite dies with an
    // unattributable "Channel closed" (ERR_IPC_CHANNEL_CLOSED) rejection rather
    // than a test failure. Bound the pool by memory instead of by cores.
    poolOptions: { forks: { maxForks: 6 } },
  },
})
