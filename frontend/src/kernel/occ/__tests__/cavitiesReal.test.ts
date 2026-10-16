// @vitest-environment node
//
// foldCavitySolids against the real kernel. The shapes are assembled by hand in
// the form OCCT 7.4.0p1's fuse hands back for a sealed void (robustness fuzz
// seed 134): the enclosing solid plus the void as its own inside-out solid.
// The fuse itself is pinned end to end by the seed-134 regression fixture.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBoxAt } from '../primitives'
import { volumeOf } from '../volume'
import { shapeIsValid, exploreSolids, countSubShapes } from '../booleans'
import { foldCavitySolids } from '../cavities'
import type { OccModule, OccShape, OccOrientableShape } from '../occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('foldCavitySolids (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  function compound(scope: DisposeScope, shapes: OccShape[]): OccShape {
    const builder = scope.track(new occ.BRep_Builder())
    const out = scope.track(new occ.TopoDS_Compound())
    builder.MakeCompound(out)
    for (const shape of shapes) builder.Add(out, shape)
    return out
  }

  // The void as OCC reports it: a box solid turned inside out.
  function voidBox(scope: DisposeScope, corner: [number, number, number], size: number): OccShape {
    const box = makeBoxAt(occ, scope, corner, size, size, size)
    return scope.track((box as OccOrientableShape).Reversed())
  }

  it('folds a void into its enclosing solid as an inner shell', () => {
    const scope = new DisposeScope()
    try {
      const outer = makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10)
      const split = compound(scope, [outer, voidBox(scope, [2, 2, 2], 2)])
      expect(volumeOf(occ, scope, split)).toBeCloseTo(992, 6)

      const folded = scope.track(foldCavitySolids(occ, scope, split))
      const solids = exploreSolids(occ, scope, folded)
      expect(solids).toHaveLength(1)
      expect(countSubShapes(occ, scope, folded, occ.TopAbs_ShapeEnum.TopAbs_SHELL)).toBe(2)
      expect(volumeOf(occ, scope, solids[0])).toBeCloseTo(992, 6)
      expect(shapeIsValid(occ, scope, folded)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('hands each void to the solid that contains it when there are several', () => {
    const scope = new DisposeScope()
    try {
      const left = makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10)
      const right = makeBoxAt(occ, scope, [20, 0, 0], 10, 10, 10)
      // Listed before its owner and inside the SECOND solid, so a fold that
      // ignored containment would put it in the wrong part.
      const split = compound(scope, [voidBox(scope, [24, 4, 4], 2), left, right])

      const folded = scope.track(foldCavitySolids(occ, scope, split))
      const volumes = exploreSolids(occ, scope, folded).map((s) => volumeOf(occ, scope, s)).sort((a, b) => a - b)
      expect(volumes).toHaveLength(2)
      expect(volumes[0]).toBeCloseTo(992, 6)
      expect(volumes[1]).toBeCloseTo(1000, 6)
      expect(shapeIsValid(occ, scope, folded)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('returns the shape itself when no solid is inside out', () => {
    const scope = new DisposeScope()
    try {
      const split = compound(scope, [
        makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10),
        makeBoxAt(occ, scope, [20, 0, 0], 10, 10, 10),
      ])
      expect(foldCavitySolids(occ, scope, split)).toBe(split)
    } finally {
      scope.dispose()
    }
  })
})
