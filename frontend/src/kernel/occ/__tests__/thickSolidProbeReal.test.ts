// @vitest-environment node
//
// Phase-1 probe for the Shell kernel path, kept as a regression test. It pins
// the OCCT 7.4.0p1 (opencascade.js 1.1.1) behaviour the thickSolid adapter is
// built on, none of which is documented for this build:
//
//   - `BRepOffsetAPI_MakeThickSolid.MakeThickSolidByJoin` is the 9-arg form
//     (shape, closingFaces, offset, tol, mode, intersection, selfInter, join,
//     removeIntEdges); a shorter call throws a BindingError.
//   - The sign: OCC offsets along the outward normal, so inward is `-t`.
//   - History: a KEPT face `Generated()` exactly one face (its offset wall), a
//     REMOVED (closing) face `Modified()` exactly one face (its rim), and the
//     kept face itself survives by IsSame. This decides the naming roles.
//   - An EMPTY closing list does NOT produce a hollow solid: it returns the
//     inward-offset solid (V=512 on a 10-cube, 6 faces). The closed hollow the
//     spec wants is `MakeOffsetShape` then a boolean cut (V=488, 12 faces), so
//     the adapter must take that fallback and the probe freezes both numbers.
//
// Skips when opencascade.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeCylinderWithFaces, faceCentroid } from '../primitives'
import { volumeOf } from '../volume'
import { canonicalFaces, canonicalEdges } from '../bodyNames'
import { booleanWithDiff } from '../booleans'
import { applyFilletWithDiff } from '../edgeModifier'
import { applyShellWithLineage } from '../thickSolid'
import type { OccModule, OccShape, OccSubShape, OccEnumValue, OccThickSolidMaker } from '../occTypes'

const oc = await loadOcc()

const boxOf = (module: OccModule, scope: DisposeScope, d: number): OccShape =>
  makeBox(module, scope, d, d, d)

/** The face whose centroid Z is greatest: the top of an axis-aligned box. */
function topFace(module: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  const faces = canonicalFaces(module, scope, shape) as OccShape[]
  return faces.reduce((best, f) =>
    faceCentroid(module, scope, f as never)[2] > faceCentroid(module, scope, best as never)[2] ? f : best,
  )
}

function bbox(module: OccModule, scope: DisposeScope, shape: OccShape): number[] {
  const box = scope.track(new module.Bnd_Box_1())
  module.BRepBndLib.Add(shape, box, false)
  return [box.GetXmin(), box.GetYmin(), box.GetZmin(), box.GetXmax(), box.GetYmax(), box.GetZmax()]
}

/** One raw thick-solid build; all inputs/scope-tracked proxies die with `scope`. */
function thickSolid(
  module: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  closing: OccShape[],
  offset: number,
  join: OccEnumValue,
): { maker: OccThickSolidMaker; result: OccShape } {
  const maker = scope.track(new module.BRepOffsetAPI_MakeThickSolid_1())
  const list = scope.track(new module.TopTools_ListOfShape_1())
  for (const f of closing) list.Append_1(f)
  maker.MakeThickSolidByJoin(
    shape, list, offset, 1e-3,
    module.BRepOffset_Mode.BRepOffset_Skin, false, false, join, false,
  )
  maker.Build()
  return { maker, result: scope.track(maker.Shape()) }
}

describe.skipIf(!oc)('thickSolid phase-1 probe (real OCC)', () => {
  function setup() {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    return oc
  }

  it('builds a top-open inward shell with the expected volume and face history', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = boxOf(module, scope, 10)
      const top = topFace(module, scope, box)
      const keptFaces = (canonicalFaces(module, scope, box) as OccShape[]).filter(
        (f) => !(f as OccSubShape).IsSame(top as OccSubShape),
      )
      const { maker, result } = thickSolid(module, scope, box, [top], -1, module.GeomAbs_JoinType.GeomAbs_Intersection)
      expect(maker.IsDone()).toBe(true)
      expect(volumeOf(module, scope, result)).toBeCloseTo(424, 6)
      expect(canonicalFaces(module, scope, result)).toHaveLength(11)

      // A closing face Modified() into its rim; a kept face Generated() its wall.
      const rim = drain(scope, maker.Modified(top))
      expect(rim).toHaveLength(1)
      expect(canonicalFaces(module, scope, rim[0]).length).toBeGreaterThan(0)
      for (const kept of keptFaces) {
        expect(maker.IsDeleted(kept)).toBe(false)
        expect(drain(scope, maker.Modified(kept))).toHaveLength(0)
        expect(drain(scope, maker.Generated(kept))).toHaveLength(1)
      }
    } finally {
      scope.dispose()
    }
  })

  it('an empty closing list returns the offset solid, not a hollow solid', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = boxOf(module, scope, 10)
      const { result } = thickSolid(module, scope, box, [], -1, module.GeomAbs_JoinType.GeomAbs_Intersection)
      // The offset solid: material 8^3 = 512, six faces, no inner void.
      expect(volumeOf(module, scope, result)).toBeCloseTo(512, 6)
      expect(canonicalFaces(module, scope, result)).toHaveLength(6)
    } finally {
      scope.dispose()
    }
  })

  it('offset then boolean cut is the closed-hollow fallback (V = 488, 12 faces)', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = boxOf(module, scope, 10)
      const off = scope.track(new module.BRepOffsetAPI_MakeOffsetShape_1())
      off.PerformByJoin(
        box, -1, 1e-3,
        module.BRepOffset_Mode.BRepOffset_Skin, false, false, module.GeomAbs_JoinType.GeomAbs_Intersection, false,
      )
      off.Build()
      expect(off.IsDone()).toBe(true)
      const inner = scope.track(off.Shape())
      // The inner void's wall history: each box face Generated() exactly one
      // offset face and is never narrating a Modified image, so the closed
      // hollow's offset names can be keyed off `Generated(sourceFace)`.
      for (const f of canonicalFaces(module, scope, box) as OccShape[]) {
        expect(drain(scope, off.Generated(f)).flatMap((g) => canonicalFaces(module, scope, g))).toHaveLength(1)
        expect(drain(scope, off.Modified(f))).toHaveLength(0)
      }
      const { shape } = booleanWithDiff(module, scope, box, inner, 'cut')
      scope.track(shape)
      expect(volumeOf(module, scope, shape)).toBeCloseTo(488, 6)
      expect(canonicalFaces(module, scope, shape)).toHaveLength(12)
    } finally {
      scope.dispose()
    }
  })

  it('outward shell grows the part and keeps sharp corners (11 faces)', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = boxOf(module, scope, 10)
      const top = topFace(module, scope, box)
      const keptFaces = (canonicalFaces(module, scope, box) as OccShape[]).filter(
        (f) => !(f as OccSubShape).IsSame(top as OccSubShape),
      )
      const { maker, result } = thickSolid(module, scope, box, [top], 1, module.GeomAbs_JoinType.GeomAbs_Intersection)
      expect(volumeOf(module, scope, result)).toBeCloseTo(584, 6)
      expect(canonicalFaces(module, scope, result)).toHaveLength(11)
      expect(bbox(module, scope, result).map((n) => Math.round(n))).toEqual([-1, -1, -1, 11, 11, 10])
      // Outward names the same way as inward: the kept inner skin survives by
      // IsSame (it carries the old UUID) and each kept face Generated() exactly
      // one offset wall; the removed face Modified() into its rim.
      const newFaces = canonicalFaces(module, scope, result) as OccShape[]
      for (const kept of keptFaces) {
        expect(newFaces.some((nf) => (nf as OccSubShape).IsSame(kept as OccSubShape))).toBe(true)
        expect(drain(scope, maker.Generated(kept))).toHaveLength(1)
      }
      expect(drain(scope, maker.Modified(top))).toHaveLength(1)
    } finally {
      scope.dispose()
    }
  })

  it('a cylinder top-open inward shell has the analytic volume', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const { shape, faces } = makeCylinderWithFaces(module, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const { result } = thickSolid(module, scope, shape, [faces.top], -1, module.GeomAbs_JoinType.GeomAbs_Intersection)
      // 250pi - 4^2 * 9 * pi = 250pi - 144pi = 106pi
      expect(volumeOf(module, scope, result)).toBeCloseTo(106 * Math.PI, 6)
    } finally {
      scope.dispose()
    }
  })

  it('canonical edge counts use IsSame dedup (a box is 12, the shell 24)', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = boxOf(module, scope, 10)
      expect(canonicalEdges(module, scope, box)).toHaveLength(12)
      const top = topFace(module, scope, box)
      const { result } = thickSolid(module, scope, box, [top], -1, module.GeomAbs_JoinType.GeomAbs_Intersection)
      expect(canonicalEdges(module, scope, result)).toHaveLength(24)
    } finally {
      scope.dispose()
    }
  })

  it('shells a box whose removed face is bounded by fillets (arc-join fallback)', () => {
    // The key_cap repro: a sharp-join thick solid refuses this shape, and so
    // does the plain offset, while the same shape offsets with arc joins. The
    // adapter must retry and hand back a real hollow, not an unchanged body.
    const module = setup()
    const scope = new DisposeScope()
    try {
      const box = makeBox(module, scope, 18, 18, 10)
      const top = topFace(module, scope, box)
      const fillet = applyFilletWithDiff(module, scope, box, 1, canonicalEdges(module, scope, top) as OccShape[])
      expect(fillet.success).toBe(true)
      const filleted = scope.track(fillet.shape)
      expect(volumeOf(module, scope, filleted)).toBeCloseTo(3224.9321491062146, 6)
      const openTop = topFace(module, scope, filleted)

      const inward = applyShellWithLineage(module, scope, filleted, [openTop], 0.75, 'inward', null)
      expect(inward.success).toBe(true)
      const inwardShape = scope.track(inward.shape)
      expect(volumeOf(module, scope, inwardShape)).toBeCloseTo(847.6863897057074, 6)
      expect(canonicalFaces(module, scope, inwardShape)).toHaveLength(20)
      // The outer top is still the opening's rim: the shell walls reach it.
      expect(Math.round(bbox(module, scope, inwardShape)[5])).toBe(10)

      const outward = applyShellWithLineage(module, scope, filleted, [openTop], 0.75, 'outward', null)
      expect(outward.success).toBe(true)
      const outwardShape = scope.track(outward.shape)
      expect(volumeOf(module, scope, outwardShape)).toBeCloseTo(854.9865869618458, 6)
      expect(canonicalFaces(module, scope, outwardShape)).toHaveLength(19)
      expect(bbox(module, scope, outwardShape).map((n) => Math.round(n))).toEqual([-1, -1, -1, 19, 19, 10])
    } finally {
      scope.dispose()
    }
  })
})

/** Drain a TopTools_ListOfShape into an array (there is no list-iterator binding). */
function drain(scope: DisposeScope, list: { Size(): number; First_1(): OccShape; RemoveFirst(): void }): OccShape[] {
  const out: OccShape[] = []
  while (list.Size() > 0) {
    out.push(scope.track(list.First_1()))
    list.RemoveFirst()
  }
  return out
}
