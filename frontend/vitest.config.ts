import os from 'node:os'
import path from 'path'
import { defineConfig, configDefaults, type ViteUserConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// CI runners can run into problems (slow tests, heavy load), so tests are far
// slower than wall-clock under load. The self-hosted arm64 runner is a
// Raspberry Pi 5: a single OCC solve there costs several times what it does on
// a hosted x86 runner, and every fork is competing for four small cores, so an
// individual test has to be allowed minutes rather than seconds. Bump timeouts
// in CI only; local keeps the snappy vitest defaults for fast feedback.
const ci = !!process.env.CI

// Vitest sizes the fork pool by core count. The `*Real.test.ts` files each
// instantiate their own OCC WASM kernel, so peak memory tracks the fork count,
// not the test count: measured across the full suite it is ~0.5 GB fixed plus
// ~0.75 GB per fork (1 fork 1.2 GB, 2 forks 2.0 GB, 3 forks 2.6 GB, 6 forks
// 5.0 GB). A core-count pool therefore reserves far more than a small-memory
// runner has -- the 4 GB arm64 runner swaps itself to a standstill, and the run
// dies with an unattributable "Channel closed" (ERR_IPC_CHANNEL_CLOSED)
// rejection as a worker is OOM-killed rather than with a test failure. Raising
// the timeouts does not fix that; it only lengthens the thrash.
//
// So the pool is bounded by CPU *and* by memory, whichever is lower. Neither
// alone is enough: a 4-core/16 GB box would over-subscribe cores, and a
// 16-core/4 GB box would OOM.

const GIB = 1024 ** 3

// Cores. `os.availableParallelism()` follows the CPU affinity mask, so a
// cpuset-limited container (`docker --cpuset-cpus`, an LXC pinned to cores,
// `taskset`) is seen correctly. A CFS bandwidth quota (`docker --cpus`, a k8s
// CPU limit) is deliberately *not* read out of the cgroup: it is invisible to
// the affinity mask, so cap a runner with a cpuset rather than a quota, or set
// VITEST_MAX_FORKS below.
const cpuForks = os.availableParallelism()

// Memory. The per-fork budget is deliberately above the measured figure, and a
// fork's worth is held back for the OS and the runner agent, because
// overshooting costs a swap death spiral while undershooting only costs
// wall-clock (6 -> 2 forks is ~2x). `os.totalmem()` reads the cgroup limit
// under lxcfs, so a memory-capped container sizes itself correctly.
const FORK_BUDGET_GIB = 1.0
const RESERVE_GIB = 1.5
const memForks = Math.floor((os.totalmem() / GIB - RESERVE_GIB) / FORK_BUDGET_GIB)

// Neither cap can see sibling runners on the same host: several of them each
// read the same totals and each claim the maximum. Set VITEST_MAX_FORKS per
// runner where that is the case.
const maxForks = Number(process.env.VITEST_MAX_FORKS) || Math.max(1, Math.min(6, cpuForks, memForks))

// @vitejs/plugin-react is typed against the app's own vite install while
// vitest/config resolves a nested one, so the identical plugin object fails
// structural assignability across the two installs. Every test run exercises
// it, so the cast only reconciles the two type views.
const reactPlugin = react() as unknown as NonNullable<ViteUserConfig['plugins']>

export default defineConfig({
  plugins: [reactPlugin],
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
    exclude: [...configDefaults.exclude, 'src/kernel/occ/__tests__/fullDocParity.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: ci ? 180000 : undefined,
    hookTimeout: ci ? 300000 : undefined,
    // Isolation is what bounds the memory above: it tears each file's OCC
    // kernel down with its module registry. Running with `isolate: false` lets
    // those heaps accumulate per worker without limit until the host OOMs, so
    // the flag is not an option here however tempting the saved WASM compiles.
    poolOptions: { forks: { maxForks } },
  },
})
