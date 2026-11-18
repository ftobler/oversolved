// @vitest-environment node
//
// Gated real-OCC test for the B2 import's kernel half: one STEP file in, one
// STEP file per solid out. The fixture is built in this test (two disjoint
// boxes compounded and written), so the expected volumes and boxes are exact.
//
// Skips when the OCC build is absent. Install:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import type { OccModule, OccShape } from '../occTypes'
import { makeBoxAt } from '../primitives'
import { stepBytesToShape, stepShapeToBytes } from '../stepIo'
import { shapeBbox } from '../faceBounds'
import { volumeOf } from '../booleans'
import { splitSolids } from '../../features/partSplit'
import { splitStepSolids } from '../stepSplit'
import { TOL_VOLUME_SUM } from '../../solverConstants'

const oc = await loadOcc()

// Two boxes far enough apart that no tolerance can read them as touching.
const BOX = 10
const OFFSET = 40

function compound(occ: OccModule, scope: DisposeScope, shapes: OccShape[]): OccShape {
  const builder = scope.track(new occ.BRep_Builder())
  const out = scope.track(new occ.TopoDS_Compound())
  builder.MakeCompound(out)
  for (const shape of shapes) builder.Add(out, shape)
  return out
}

// A face on its own: the shape a surfaces-only file carries, with no solid for
// the split to find.
function loneFace(occ: OccModule, scope: DisposeScope): OccShape {
  const box = scope.track(makeBoxAt(occ, scope, [0, 0, 0], BOX, BOX, BOX))
  const exp = scope.track(new occ.TopExp_Explorer_2(box, occ.TopAbs_ShapeEnum.TopAbs_FACE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE))
  return scope.track(occ.TopoDS.Face_1(exp.Current()))
}

describe.skipIf(!oc)('splitStepSolids (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('writes one STEP file per solid, keeping each volume and world box', () => {
    const scope = new DisposeScope()
    try {
      const first = scope.track(makeBoxAt(occ, scope, [0, 0, 0], BOX, BOX, BOX))
      const second = scope.track(makeBoxAt(occ, scope, [OFFSET, 0, 0], BOX, BOX, BOX))
      const bytes = stepShapeToBytes(occ, scope, compound(occ, scope, [first, second]))

      const split = splitStepSolids(occ, scope, bytes)
      expect(split.solids).toHaveLength(2)
      expect(split.leftovers).toBe(0)

      const readBack = split.solids.map((solid) => {
        const read = scope.track(stepBytesToShape(occ, scope, solid.bytes))
        expect(splitSolids(occ, scope, read)).toHaveLength(1)
        return read
      })
      const sourceSolids = splitSolids(occ, scope, scope.track(stepBytesToShape(occ, scope, bytes)))
      readBack.forEach((shape, index) => {
        const volume = Math.abs(volumeOf(occ, scope, shape))
        expect(Math.abs(volume - BOX ** 3)).toBeLessThanOrEqual(TOL_VOLUME_SUM * BOX ** 3)
        expect(Math.abs(split.solids[index].volume - BOX ** 3)).toBeLessThanOrEqual(TOL_VOLUME_SUM * BOX ** 3)
        // World placement survives: the split file is not recentred.
        const box = shapeBbox(occ, scope, shape)
        const source = shapeBbox(occ, scope, sourceSolids[index])
        box.forEach((value, i) => expect(value).toBeCloseTo(source[i], 9))
      })
    } finally {
      scope.dispose()
    }
  })

  it('reports zero solids and the leftover faces of a surfaces-only file', () => {
    const scope = new DisposeScope()
    try {
      const bytes = stepShapeToBytes(occ, scope, loneFace(occ, scope))

      const split = splitStepSolids(occ, scope, bytes)

      expect(split.solids).toEqual([])
      expect(split.leftovers).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('keeps a single solid whole', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBoxAt(occ, scope, [3, 4, 5], BOX, BOX, BOX))
      const bytes = stepShapeToBytes(occ, scope, box)

      const split = splitStepSolids(occ, scope, bytes)

      expect(split.solids).toHaveLength(1)
      expect(split.leftovers).toBe(0)
      const read = scope.track(stepBytesToShape(occ, scope, split.solids[0].bytes))
      const splitBox = shapeBbox(occ, scope, read)
      const sourceBox = shapeBbox(occ, scope, box)
      splitBox.forEach((value, i) => expect(value).toBeCloseTo(sourceBox[i], 9))
    } finally {
      scope.dispose()
    }
  })
})
