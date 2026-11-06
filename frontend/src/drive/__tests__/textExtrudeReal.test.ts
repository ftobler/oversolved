// @vitest-environment node
//
// End to end through the real kernel: text written by one add_text step and
// extruded once is a solid whose volume is the outline area times the depth,
// with the area computed exactly from the stored params (testing/outlineArea),
// and an "O" cut into a plate removes a ring, not a filled disc. The second is
// the test that fails if the profile builder ever fills a counter; a face
// count cannot tell, since filling a counter removes faces.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { featureById } from '@/testing/featureAccess'
import { outlineSignedArea } from '@/testing/outlineArea'

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

const DEPTH = 5

function storedArea(doc: PartDoc, sketchId: string): number {
  const sketch: SketchFeature = featureById(doc, sketchId, 'sketch')
  return Math.abs(outlineSignedArea((sketch.entities ?? []).map(e => ({ kind: e.kind, params: sketch.initial![e.id] }))))
}

async function solved(steps: ScriptStep[]): Promise<{ volume: number; doc: PartDoc }> {
  const run = await runHeadless({ doc: emptyDriveDoc(), steps })
  expect(run.ok).toBe(true)
  expect(run.features).toEqual([])
  const measured = await measureHeadless(run.doc!)
  expect(measured?.ok).toBe(true)
  return { volume: measured!.measures.volume, doc: run.doc! }
}

describe.skipIf(!ready)('add_text extrudes to its outline area (real kernel)', () => {
  it('"OI" extruded 5 has the stored outline area times the depth', async () => {
    const { volume, doc } = await solved([
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_text', featureId: 'sk1', text: 'OI', origin: [0, 0], size: 20 } },
      { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: DEPTH, operation: 'new' } },
    ])
    const area = storedArea(doc, 'sk1')
    expect(area).toBeGreaterThan(0)
    expect(Math.abs(volume - area * DEPTH) / (area * DEPTH)).toBeLessThan(1e-9)
  }, 180_000)

  it('"O" cut into a plate removes the ring only; the counter stays solid', async () => {
    const PLATE = { x0: -5, y0: -10, x1: 25, y1: 25, depth: 10 }
    const { volume, doc } = await solved([
      { mutation: { type: 'add_sketch', featureId: 'skPlate', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_rect', featureId: 'skPlate', p0: [PLATE.x0, PLATE.y0], p1: [PLATE.x1, PLATE.y1] } },
      { mutation: { type: 'add_extrude', featureId: 'exPlate', sketchQuery: '$skPlate', distance: PLATE.depth, operation: 'new' } },
      { mutation: { type: 'add_sketch', featureId: 'skText', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_text', featureId: 'skText', text: 'O', origin: [0, 0], size: 20 } },
      { mutation: { type: 'add_extrude', featureId: 'exCut', sketchQuery: '$skText', distance: DEPTH, operation: 'cut' } },
    ])
    const plate = (PLATE.x1 - PLATE.x0) * (PLATE.y1 - PLATE.y0) * PLATE.depth
    const ring = storedArea(doc, 'skText')
    const expected = plate - ring * DEPTH
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-9)
  }, 180_000)
})
