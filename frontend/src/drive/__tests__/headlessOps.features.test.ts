// @vitest-environment node
//
// The reply fields the CLI and MCP server share: the features a solve did not
// finish cleanly, the empty-script "inspect this document" solve, and the
// measure reply carrying the same list. Real kernel, gated like the other
// drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { HOLE_ALL_SITES_MISS, HOLE_ON_LINE_SKETCH } from './featureFixtures'
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
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

const ready = oc && solveBytes

describe.skipIf(!ready)('headless feature problems (real OCC + Rust solver)', () => {
  it('reports an empty list for a clean box, and does not list an underconstrained sketch', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    // The box's sketch IS underconstrained: a normal sketch state, not a
    // problem, so the list above must stay empty while the outcome exists.
    expect(result.part.solveOutcomes().sk1?.status).toBe('underconstrained')
  }, 120_000)

  it('lists a failed hole with its kernel message and does not flip ok', async () => {
    const result = await runHeadless({ doc: emptyDoc(), steps: HOLE_ON_LINE_SKETCH })
    expect(result.ok).toBe(true)
    expect(result.solve.lastError).toBeNull()
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(result.features[0].message).toMatch(/has no point/)
  }, 120_000)

  it('lists an ok-with-warning hole and keeps the warning text', async () => {
    const result = await runHeadless({ doc: emptyDoc(), steps: HOLE_ALL_SITES_MISS })
    expect(result.ok).toBe(true)
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'ok' })
    expect(result.features[0].message).toMatch(/none of the 1 drill site\(s\) intersect/)
  }, 120_000)

  it('solves a passed document once when the script is empty', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    const inspected = await runHeadless({ doc: built.doc!, steps: [] })
    expect(inspected.ok).toBe(true)
    expect(inspected.outcome.steps).toEqual([])
    expect(inspected.solve.generation).toBeGreaterThan(0)
    expect(typeof inspected.docHash).toBe('string')
    expect(inspected.features).toEqual([])
  }, 120_000)

  it('measure returns the same feature list as run', async () => {
    const clean = await runHeadless({ doc: emptyDoc(), steps: HOLE_ON_LINE_SKETCH })
    const measured = await measureHeadless(clean.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.features).toHaveLength(1)
    expect(measured!.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(measured!.features[0].message).toMatch(/has no point/)
  }, 120_000)
})
