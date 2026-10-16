// @vitest-environment node
//
// Gated real-OCC test for offsetSolid (kernel/occ/offsetShape.ts): the sharp-join
// 3D offset that grows a boolean subtract's tool. Pins the volumes against the
// plan's analytic values, the shell-wrap for non-primitive input, and the
// failure of a clearance the tool cannot take.
//
// Skips when opencascade.js is absent, like the other real-OCC gates.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeBoxAt, makeCylinder } from '../primitives'
import { booleanWithDiff, countSubShapes, shapeIsValid, volumeOf } from '../booleans'
import { applyFilletWithDiff } from '../edgeModifier'
import { offsetSolid, OffsetError } from '../offsetShape'
import type { OccModule, OccOrientableShape, OccShape, OccSubShape } from '../occTypes'
import type { Vec3 } from '../primitives'

const oc = await loadOcc()

function edgesOf(occ: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(occ.TopoDS.Edge_1(exp.Current())))
  return out
}

function sourceFaces(occ: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(exp.Current()) as OccSubShape)
  return out
}

describe.skipIf(!oc)('offsetSolid (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('grows a box by +0.1 to the analytic volume, one image per source face', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 4, 4, 12)
      const grown = offsetSolid(occ, scope, box, 0.1)
      const result = scope.track(grown.shape)
      expect(volumeOf(occ, scope, result)).toBeCloseTo(4.2 * 4.2 * 12.2, 6)
      expect(countSubShapes(occ, scope, result, occ.TopAbs_ShapeEnum.TopAbs_FACE)).toBe(6)

      // Every source face maps to exactly one face of the result, and the images
      // are distinct (a one-to-one naming contract).
      const sources = sourceFaces(occ, scope, box)
      expect(sources).toHaveLength(6)
      const images = sources.map((f) => grown.faceImage(f))
      expect(new Set(images).size).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('grows a cylinder by +0.1 to the analytic volume', () => {
    const scope = new DisposeScope()
    try {
      const cyl = makeCylinder(occ, scope, [0, 0, 0], [0, 0, 1] as Vec3, 2, 12)
      const grown = offsetSolid(occ, scope, cyl, 0.1)
      const result = scope.track(grown.shape)
      expect(volumeOf(occ, scope, result)).toBeCloseTo(Math.PI * 2.1 * 2.1 * 12.2, 6)
    } finally {
      scope.dispose()
    }
  })

  it('shrinks a box by -0.1 to the analytic volume', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 4, 4, 12)
      const grown = offsetSolid(occ, scope, box, -0.1)
      const result = scope.track(grown.shape)
      expect(volumeOf(occ, scope, result)).toBeCloseTo(3.8 * 3.8 * 11.8, 6)
    } finally {
      scope.dispose()
    }
  })

  it('wraps the SHELL a filleted box offsets to into a valid solid (26/26 images)', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 4, 4, 12)
      const fillet = applyFilletWithDiff(occ, scope, box, 0.5, edgesOf(occ, scope, box))
      expect(fillet.success).toBe(true)
      const filleted = scope.track(fillet.shape)

      const grown = offsetSolid(occ, scope, filleted, 0.1)
      const result = scope.track(grown.shape)
      // The raw offset is a shell; the returned shape must be the wrapped solid.
      expect(countSubShapes(occ, scope, result, occ.TopAbs_ShapeEnum.TopAbs_SOLID)).toBe(1)
      expect(shapeIsValid(occ, scope, result)).toBe(true)
      expect(countSubShapes(occ, scope, result, occ.TopAbs_ShapeEnum.TopAbs_FACE)).toBe(26)
      expect(volumeOf(occ, scope, result)).toBeCloseTo(209.131, 3)

      const sources = sourceFaces(occ, scope, filleted)
      expect(sources).toHaveLength(26)
      for (const f of sources) expect(grown.faceImage(f)).toBeDefined()
    } finally {
      scope.dispose()
    }
  })

  it('refuses a clearance a slotted box cannot take (OffsetError)', () => {
    const scope = new DisposeScope()
    try {
      const base = makeBox(occ, scope, 10, 10, 8)
      // A through slot opening at x = 0.5..1.5, leaving a thin wall the negative
      // clearance drives through; the offset op cannot complete.
      const slot = makeBoxAt(occ, scope, [0.5, 0, 0] as Vec3, 1, 10, 8)
      const slotted = booleanWithDiff(occ, scope, base, slot, 'cut').shape
      scope.track(slotted)
      expect(() => offsetSolid(occ, scope, slotted, -0.6)).toThrow(OffsetError)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a zero clearance (the feature never calls it with zero)', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 4, 4, 12)
      expect(() => offsetSolid(occ, scope, box, 0)).toThrow(OffsetError)
    } finally {
      scope.dispose()
    }
  })

  it('reverses a negatively oriented offset result so no negative-volume tool escapes', () => {
    const scope = new DisposeScope()
    try {
      // An inside-out input makes the raw offset come back with a negative
      // signed volume; the guard must reverse it (plan step 3) rather than hand
      // a negative-volume tool to the cut.
      const box = makeBox(occ, scope, 4, 4, 12)
      const reversed = scope.track((box as OccOrientableShape).Reversed())
      const grown = offsetSolid(occ, scope, reversed, 0.1)
      const result = scope.track(grown.shape)
      expect(volumeOf(occ, scope, result)).toBeGreaterThan(0)
      expect(volumeOf(occ, scope, result)).toBeCloseTo(3.8 * 3.8 * 11.8, 3)
    } finally {
      scope.dispose()
    }
  })
})
