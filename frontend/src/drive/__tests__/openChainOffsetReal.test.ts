// @vitest-environment node
//
// The sheet-metal recipe end to end, both mirror twins: draw the bend line
// open, fillet the corner, offset by the thickness, cap both ends, extrude. The
// left-turning twin used to fail the extrude with "no closed profile found"
// because its line copies went one side and the arc copy the other; the right
// twin only worked by coincidence of its draw directions. Volume: 7 + 7 +
// pi/4 * (3^2 - 2^2), the quarter annulus between r3 and r2 plus the two 7 x 1
// runs. Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc, type HeadlessRunResult } from '../headlessOps'
import type { ScriptStep } from '../scriptRunner'
import { featureById } from '@/testing/featureAccess'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { nonSketchProblems } from './buildProblems'

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

const VOLUME = 7 + 7 + (Math.PI / 4) * (3 ** 2 - 2 ** 2)

function sketchOf(doc: PartDoc): SketchFeature {
  return featureById(doc, 'sk1', 'sketch')
}

interface Twin {
  l1: number[]
  l2: number[]
  distance: number
  cap2: number[]
}

const LEFT: Twin = { l1: [0, 0, -10, 0], l2: [-10, 0, -10, -10], distance: 1, cap2: [-10, -10, -9, -10] }
const RIGHT: Twin = { l1: [0, 0, 10, 0], l2: [10, 0, 10, -10], distance: -1, cap2: [10, -10, 9, -10] }

async function bendThenOffset(twin: Twin): Promise<HeadlessRunResult> {
  const outlined = await runHeadless({
    doc: emptyDriveDoc(),
    steps: [
      { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: twin.l1, entityId: 'l1' } },
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: twin.l2, entityId: 'l2' } },
      { mutation: { type: 'fillet_corners', featureId: 'sk1', radius: 3, corners: [
        { a: 'l1', aVertex: 'end', b: 'l2', bVertex: 'start' },
      ] } },
    ],
  })
  expect(outlined.ok).toBe(true)
  expect(nonSketchProblems(outlined.features)).toEqual([])
  const arcId = sketchOf(outlined.doc!).entities!.find(entity => entity.kind === 'arc')!.id

  const steps: ScriptStep[] = [
    { mutation: { type: 'apply_offset', featureId: 'sk1', sourceIds: ['l1', arcId, 'l2'], distance: twin.distance } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -1, 0, 0], entityId: 'cap1' } },
    { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: twin.cap2, entityId: 'cap2' } },
    { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' } },
  ]
  return runHeadless({ doc: outlined.doc!, steps })
}

describe.skipIf(!ready)('open-chain offset closes both mirror twins into the same solid', () => {
  for (const [name, twin] of [['left-turning +1', LEFT], ['right-turning -1', RIGHT]] as const) {
    it(`${name}: the chain offsets inside, the caps close it, volume ${VOLUME}`, async () => {
      const built = await bendThenOffset(twin)
      expect(built.ok).toBe(true)
      expect(nonSketchProblems(built.features)).toEqual([])

      // One r2 arc copy beside the authored r3 fillet, and the chain is the same
      // three entities on each side.
      const arcs = sketchOf(built.doc!).entities!.filter(entity => entity.kind === 'arc')
      const radii = arcs.map(entity => sketchOf(built.doc!).initial![entity.id][2]).sort((a, b) => a - b)
      expect(radii).toEqual([2, 3])

      const measured = await measureHeadless(built.doc!)
      expect(measured).not.toBeNull()
      expect(measured!.ok).toBe(true)
      expect(nonSketchProblems(measured!.features)).toEqual([])
      expect(measured!.measures.volume).toBeCloseTo(VOLUME, 9)
    }, 240_000)
  }

  it('the twins measure the same volume', async () => {
    const left = await bendThenOffset(LEFT)
    const right = await bendThenOffset(RIGHT)
    const leftMeasured = await measureHeadless(left.doc!)
    const rightMeasured = await measureHeadless(right.doc!)
    expect(leftMeasured!.measures.volume).toBeCloseTo(rightMeasured!.measures.volume, 9)
  }, 240_000)
})
