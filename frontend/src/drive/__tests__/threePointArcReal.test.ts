// @vitest-environment node
//
// The three-point arc's own contract end to end: one mutation closes a profile
// against the line it snapped to, so the extrude has a region without a hand
// written coincident per joint. A semicircle of radius 1 swept along a unit
// extrude is pi/2.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { measureHeadless, runHeadless, seedBuiltins } from '../headlessOps'
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
const ready = oc && solveBytes

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

describe.skipIf(!ready)('add_three_point_arc (real OCC + Rust solver)', () => {
  it('closes a line-and-arc profile by pinning both ends to the line', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 2, 0], entityId: 'l1' } },
        {
          mutation: {
            type: 'add_three_point_arc', featureId: 'sk1',
            start: [2, 0], through: [1, 1], end: [0, 0],
            startRef: 'vertex:sk1:l1:end', endRef: 'vertex:sk1:l1:start', entityId: 'a1',
          },
        },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
      ],
    })
    expect(result.ok).toBe(true)

    const sketch = result.doc!.features!.find(feature => feature.id === 'sk1') as SketchFeature
    const step = result.outcome.steps[2]
    const constraintIds = new Set(sketch.constraints!.map(c => c.id))
    expect(step.createdIds).toHaveLength(3)
    expect(step.createdIds[0]).toBe('a1')
    expect(step.createdIds.slice(1).every(id => constraintIds.has(id))).toBe(true)
    // Not a compact sugar row: every id it mints is named, no count is needed.
    expect(step).not.toHaveProperty('constraints')

    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.features).toEqual([])
    const volume = measured!.measures.volume
    expect(Math.abs(volume - Math.PI / 2) / (Math.PI / 2)).toBeLessThan(1e-9)
  }, 240_000)
})
