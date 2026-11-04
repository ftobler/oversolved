// @vitest-environment node
//
// The large-match select reply against the real kernel: a body with hundreds
// of edges, where the per-item geometry summary is what pushed the reply past a
// client's token limit. The fixture is about 40 disjoint rectangles in one
// sketch, extruded once, so every rect becomes its own body; each body
// contributes four edges parallel to world Z. The queries-only reply must keep
// the whole answer and drop only the summary.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, selectHeadless, seedBuiltins } from '../headlessOps'
import { selectReply } from '../mcpDocRef'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'

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
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

const RECTS = 36
const RECTS_PER_ROW = 6
// Four world-Z edges per extruded rect, so the fixture's match count is fixed
// by construction rather than by a hand count of a production document.
const Z_EDGES = RECTS * 4

function plateSteps(): ScriptStep[] {
  const steps: ScriptStep[] = [step({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' })]
  for (let i = 0; i < RECTS; i++) {
    const x = (i % RECTS_PER_ROW) * 20
    const y = Math.floor(i / RECTS_PER_ROW) * 20
    steps.push(step({ type: 'add_rect', featureId: 'sk1', p0: [x, y], p1: [x + 10, y + 10] }))
  }
  steps.push(step({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' }))
  return steps
}

describe.skipIf(!ready)('the large-match select reply (real OCC)', () => {
  it('keeps every query and drops the geometry summary in queries detail', async () => {
    const built = await runHeadless({ doc: emptyDoc(), steps: plateSteps() })
    expect(built.ok).toBe(true)
    await yieldToEventLoop()
    const measured = await measureHeadless(built.doc as PartDoc)
    expect(measured!.measures.bodies).toBe(RECTS)
    await yieldToEventLoop()

    const result = (await selectHeadless(built.doc as PartDoc, {
      kind: 'edge',
      where: { parallel: [0, 0, 1] },
    }))!
    expect(result.queries).toHaveLength(Z_EDGES)

    const queries = selectReply('docHash1', result, 'queries')
    expect(queries.count).toBe(Z_EDGES)
    expect(queries.queries).toEqual(result.queries)
    // The reply is exactly the envelope plus the queries: no per-item summary.
    expect(Object.keys(queries)).toEqual(['ok', 'docHash', 'count', 'queries'])

    const full = selectReply('docHash1', result, 'full')
    expect(full.count).toBe(Z_EDGES)
    expect((full.items as unknown[])).toHaveLength(Z_EDGES)

    const queriesSize = JSON.stringify(queries).length
    const payloadSize = JSON.stringify(result.queries).length
    const fullSize = JSON.stringify(full).length
    // Only the small ok/docHash/count envelope sits around the query payload.
    expect(queriesSize - payloadSize).toBeLessThan(200)
    // The 144-edge fixture is about 15 kB of queries, so this ceiling proves the
    // geometry was dropped without capping the answer.
    expect(queriesSize).toBeLessThan(20_000)
    expect(fullSize).toBeGreaterThan(queriesSize * 2)
  }, 240_000)
})
