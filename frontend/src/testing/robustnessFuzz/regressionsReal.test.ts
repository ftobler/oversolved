// @vitest-environment node
//
// Replays every minimised recipe the chain sweep wrote to regressions/. The
// sweep only writes a fixture when a seed fails, so without this suite a fixed
// finding would stay fixed only for as long as the generator keeps drawing the
// same chain; the frozen recipe pins it regardless of generator changes.
//
// Each fixture replays in-process on one fresh kernel: they are short
// (minimised) and the regressions are kernel-visible geometry faults, not
// hangs, so the watchdog child is not needed. Skips where OCC.js is absent.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { runChain } from './chain'
import { defaultRegressionsDir, type MinimalRecipeFile } from './regressions'
import type { OccModule } from '@/kernel/occ/occTypes'

const oc = await loadOcc()
const dir = defaultRegressionsDir()
const fixtures = readdirSync(dir).filter((name) => name.endsWith('-minimal.json')).sort()

describe.skipIf(!oc)('the robustness fuzz regression fixtures (real kernel)', () => {
  for (const name of fixtures) {
    it(`${name} replays without a violation`, { timeout: 60_000 }, () => {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as MinimalRecipeFile
      const run = runChain(oc as OccModule, { seed: entry.seed, steps: entry.steps })
      expect(run.violations).toEqual([])
    })
  }
})
