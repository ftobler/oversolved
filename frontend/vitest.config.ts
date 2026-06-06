import path from 'path'
import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

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
  },
})
