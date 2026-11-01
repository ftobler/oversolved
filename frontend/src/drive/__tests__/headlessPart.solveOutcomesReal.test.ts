// @vitest-environment node
//
// The per-feature outcome as the headless session publishes it, through the
// real kernel. The reported bug was a hole whose sketch named no drill site:
// the feature solved to 'exception', but the MCP reply said ok with a clean
// solve, so only this map (and the reply built from it) can name the failure.
// Gated like the other real suites: skips when OCC.js or the Rust node build is
// absent.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { createHeadlessPart } from '../headlessPart'
import { HOLE_ON_LINE_SKETCH } from './featureFixtures'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

// The reported document, minimal: a plate, a boss built from a circle, and a
// hole whose whole-sketch pick names a sketch that holds no point or circle.
// The bug report's own sk3 carried a circle, which the kernel now drills; the
// refusals that still matter are a sketch with no drill site and a real
// exception, so the shared fixture puts a line in that sketch.
describe.skipIf(!oc || !solveBytes)('headlessPart solveOutcomes (real OCC + Rust solver)', () => {
  it('keeps the exception status and message of a feature that failed', async () => {
    const part = createHeadlessPart({ doc: emptyDoc() })
    const outcome = await part.run(HOLE_ON_LINE_SKETCH)
    expect(outcome.ok).toBe(true)

    const outcomes = part.solveOutcomes()
    expect(outcomes.h1).toMatchObject({ status: 'exception' })
    expect(outcomes.h1?.exception).toMatch(/has no point/)
    expect(outcomes.ex1?.status).not.toBe('exception')
    expect(outcomes.ex2?.status).not.toBe('exception')
    // The status-only view stays the derived shape the repro test reads.
    expect(part.solveStatuses().h1).toBe('exception')
  }, 120_000)
})
