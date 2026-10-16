// @vitest-environment node
//
// Phase-1 probe for the draft kernel path, kept as a regression test. It pins
// the OCCT 7.4.0p1 (opencascade.js 1.1.1) behaviour the draft adapter
// (occ/draftAngle.ts) is built on, none of which is documented for this build:
//
//   - `new BRepOffsetAPI_DraftAngle_1()` + `Init(shape)` is the bound
//     constructor path; `gp_Pln_3(point, direction)` is the bound plane
//     constructor (there is no declared `gp_Pln` point-and-direction alias).
//   - `Add(face, direction, angleRadians, neutralPlane, flag)` is the 5-argument
//     form; `AddDone()` precedes `Build()`. The flag changes nothing on the
//     analytic cases (it only tells the maker how hard to check the face).
//   - History: a DRAFTED face is `Generated()` into its tilted image and
//     reports neither `Modified` nor `IsDeleted`; its neighbours (the faces
//     whose boundary the tilt moved) are `Modified()`; a face the draft does
//     not touch is `IsSame` in the output.
//   - Sign: with the neutral plane at z=0 and the pull direction +z, a POSITIVE
//     angle recedes along the pull direction. One box side drafted 10 degrees is
//     V = 911.837 (1000 - 10*tan(10deg)*10/2), both sides 823.673, and -10
//     degrees grows to 1176.327.
//
// Skips when opencascade.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope, drainList } from '../disposeScope'
import { canonicalFaces } from '../bodyNames'
import { volumeOf } from '../volume'
import { faceCentroid } from '../primitives'
import type { OccDraftAngleMaker, OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

const sameSub = (a: OccShape, b: OccShape): boolean => (a as unknown as { IsSame(o: unknown): boolean }).IsSame(b)

/** The faces whose normal is along +-x: the box's two x-facing sides. */
function xSides(module: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return (canonicalFaces(module, scope, shape) as OccShape[]).filter((f) => {
    const ad = scope.track(new module.BRepAdaptor_Surface_2(f, true))
    const pln = scope.track(ad.Plane())
    const ax3 = scope.track(pln.Position())
    const d = scope.track(ax3.Direction())
    const along = Math.abs(d.X()) > 0.99
    d.delete()
    ax3.delete()
    return along
  })
}

/** The face whose centroid's z is `z`: the box's bottom/top in 0..10. */
function zFace(module: OccModule, scope: DisposeScope, shape: OccShape, z: number): OccShape {
  return (canonicalFaces(module, scope, shape) as OccShape[]).find(
    (f) => Math.abs(faceCentroid(module, scope, f)[2] - z) < 1e-6,
  )!
}

function draftBox(
  module: OccModule,
  scope: DisposeScope,
  box: OccShape,
  faces: OccShape[],
  angleDeg: number,
  flag: boolean,
): { maker: OccDraftAngleMaker; result: OccShape } {
  const maker = scope.track(new module.BRepOffsetAPI_DraftAngle_1())
  const dir = scope.track(new module.gp_Dir_4(0, 0, 1))
  const pnt = scope.track(new module.gp_Pnt_3(0, 0, 0))
  const pln = scope.track(new module.gp_Pln_3(pnt, dir))
  maker.Init(box)
  for (const f of faces) maker.Add(f, dir as unknown as OccShape, (angleDeg * Math.PI) / 180, pln as unknown as OccShape, flag)
  maker.AddDone()
  maker.Build()
  return { maker, result: scope.track(maker.Shape()) }
}

describe.skipIf(!oc)('DraftAngle phase-1 probe (real OCC)', () => {
  function setup() {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    return oc
  }

  it('drafts one box side with the analytic volume', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = scope.track(new module.BRepPrimAPI_MakeBox_1(10, 10, 10).Shape())
      const one = xSides(module, scope, box).slice(0, 1)
      expect(one).toHaveLength(1)
      const { maker, result } = draftBox(module, scope, box, one, 10, true)
      expect(maker.IsDone()).toBe(true)
      expect(canonicalFaces(module, scope, result)).toHaveLength(6)
      // 1000 - (10 * tan(10deg)) * 10 / 2 = 911.8365.
      expect(volumeOf(module, scope, result)).toBeCloseTo(911.8365096457674, 6)
    } finally {
      scope.dispose()
    }
  })

  it('drafts both x sides and mirrors the sign', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = scope.track(new module.BRepPrimAPI_MakeBox_1(10, 10, 10).Shape())
      const two = xSides(module, scope, box)
      expect(two).toHaveLength(2)
      const inward = draftBox(module, scope, box, two, 10, true)
      expect(volumeOf(module, scope, inward.result)).toBeCloseTo(823.673019291535, 6)
      // The flag is a checking hint: same geometry either way.
      const flagged = draftBox(module, scope, box, two, 10, false)
      expect(volumeOf(module, scope, flagged.result)).toBeCloseTo(823.673019291535, 6)
      const grown = draftBox(module, scope, box, two, -10, true)
      expect(volumeOf(module, scope, grown.result)).toBeCloseTo(1176.326980708465, 6)
    } finally {
      scope.dispose()
    }
  })

  it('reports a drafted face through Generated, its neighbours through Modified, and the rest by identity', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = scope.track(new module.BRepPrimAPI_MakeBox_1(10, 10, 10).Shape())
      const sides = xSides(module, scope, box)
      // The y=0 side is the drafted one (its centroid y is 0 on a 0..10 box).
      const drafted = (canonicalFaces(module, scope, box) as OccShape[]).find(
        (f) => Math.abs(faceCentroid(module, scope, f)[1]) < 1e-6,
      )!
      const { maker, result } = draftBox(module, scope, box, [drafted], 10, true)
      const outFaces = canonicalFaces(module, scope, result) as OccShape[]

      const generated = drainList(scope, maker.Generated(drafted)).flatMap((g) => canonicalFaces(module, scope, g) as OccShape[])
      const modified = drainList(scope, maker.Modified(drafted)).flatMap((g) => canonicalFaces(module, scope, g) as OccShape[])
      expect(maker.IsDeleted(drafted)).toBe(false)
      expect(generated).toHaveLength(1)
      expect(modified).toHaveLength(0)
      expect(outFaces.some((f) => sameSub(f, generated[0]))).toBe(true)

      // The two x sides border the drafted face, so they are Modified images;
      // the untouched y=10 side is IsSame in the output.
      for (const side of sides) {
        const images = drainList(scope, maker.Modified(side)).flatMap((g) => canonicalFaces(module, scope, g) as OccShape[])
        expect(images).toHaveLength(1)
        expect(outFaces.some((f) => sameSub(f, images[0]))).toBe(true)
      }
      const opposite = (canonicalFaces(module, scope, box) as OccShape[]).find(
        (f) => Math.abs(faceCentroid(module, scope, f)[1] - 10) < 1e-6,
      )!
      expect(maker.IsDeleted(opposite)).toBe(false)
      expect(drainList(scope, maker.Modified(opposite))).toHaveLength(0)
      expect(outFaces.some((f) => sameSub(f, opposite))).toBe(true)    } finally {
      scope.dispose()
    }
  })

  it('drafting a face the neutral plane does not touch fails at the build, not at Add', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = scope.track(new module.BRepPrimAPI_MakeBox_1(10, 10, 10).Shape())
      const maker = scope.track(new module.BRepOffsetAPI_DraftAngle_1())
      const dir = scope.track(new module.gp_Dir_4(0, 0, 1))
      const pnt = scope.track(new module.gp_Pnt_3(0, 0, 0))
      const pln = scope.track(new module.gp_Pln_3(pnt, dir))
      maker.Init(box)
      // The top face is parallel to the neutral plane and does not touch it, so
      // the draft has no intersection line to rotate about. `Add` accepts it
      // (nothing is validated there); the failure surfaces when the accumulated
      // draft is processed, as an OCC error the caller sees as a throw. The leaf
      // therefore treats a build-level failure as a red feature, not as a
      // per-face refusal.
      const top = zFace(module, scope, box, 10)
      maker.Add(top, dir as unknown as OccShape, (10 * Math.PI) / 180, pln as unknown as OccShape, true)
      expect(() => {
        maker.AddDone()
        maker.Build()
      }).toThrow()
    } finally {
      scope.dispose()
    }
  })
})
