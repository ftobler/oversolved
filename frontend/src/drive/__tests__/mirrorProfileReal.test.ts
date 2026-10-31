// @vitest-environment node
//
// A mirror of an authored half profile across a construction axis, extruded:
// the seam edge on the axis is authored once and serves both halves, the three
// cloned edges close the other one. The measured volume is the symmetric
// analytic number, which pins the whole chain end to end: mirrored authored
// clones -> positional loop assembly -> even/odd fill -> extrude. Real kernel,
// gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc, type HeadlessRunResult } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
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

// A 3 x 4 half rectangle right of the axis x=0, its seam edge lying on the
// axis, plus the construction axis line `ax`. Only the three non-seam edges
// are mirrored (the seam is on the axis: the drive refuses it as a source,
// and the seam stays one edge shared by both halves). Volume: 2 * 12 * 5.
async function mirroredHalf(): Promise<HeadlessRunResult> {
  const steps: ScriptStep[] = [
    { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -3, 0, 3], entityId: 'ax' } },
    { mutation: { type: 'toggle_construction', targets: ['entity:sk1:ax'] } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -2, 0, 2], entityId: 'seam' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 2, 3, 2], entityId: 'top' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, 2, 3, -2], entityId: 'side' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, -2, 0, -2], entityId: 'bottom' } },
    { mutation: { type: 'mirror_entities', featureId: 'sk1', sourceIds: ['top', 'side', 'bottom'], line: 'ax' } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5 } },
  ]
  return runHeadless({ doc: emptyDriveDoc(), steps })
}

function sketchEntities(doc: PartDoc): Record<string, number[]> {
  const sketch = doc.features.find((f: PartFeature) => f.id === 'sk1')
  return sketch?.initial ?? {}
}

describe.skipIf(!ready)('mirror_entities extrudes to the symmetric volume (real kernel)', () => {
  it('the sketch after the mirror carries the clones and one shared seam edge', async () => {
    const built = await mirroredHalf()
    expect(built.ok).toBe(true)
    expect(built.features).toEqual([])

    const initial = sketchEntities(built.doc!)
    const lines = Object.entries(initial)
    expect(lines.filter(([, params]) => JSON.stringify(params) === '[0,-2,0,2]')).toHaveLength(1)  // the seam is not mirrored
    const mirrored = lines.filter(([, params]) => params[0] <= 0 && params[2] <= 0 && !(params[0] === 0 && params[2] === 0))
    expect(mirrored.map(([, params]) => params)).toEqual([
      [0, 2, -3, 2],      // top
      [-3, 2, -3, -2],    // side
      [-3, -2, 0, -2],    // bottom
    ])
  }, 120_000)

  it('the extrude is the full 6 x 4 x 5 box: 120, symmetric about the axis', async () => {
    const built = await mirroredHalf()
    const measured = await measureHeadless(built.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.ok).toBe(true)
    expect(measured!.features).toEqual([])
    expect(measured!.measures.volume).toBeCloseTo(120, 6)
    const { bbox, centroid } = measured!.measures
    expect(bbox).not.toBeNull()
    expect(bbox![0]).toBeCloseTo(-3, 6)
    expect(bbox![3]).toBeCloseTo(3, 6)
    expect(bbox![1]).toBeCloseTo(-2, 6)
    expect(bbox![4]).toBeCloseTo(2, 6)
    expect(bbox![5] - bbox![2]).toBeCloseTo(5, 6)  // the depth, whichever side the normal took
    expect(centroid).not.toBeNull()
    expect(centroid![0]).toBeCloseTo(0, 6)  // mirrored halves balance across x=0
    expect(centroid![1]).toBeCloseTo(0, 6)
  }, 120_000)
})
