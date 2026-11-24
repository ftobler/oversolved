// @vitest-environment node
//
// Real-OCC gate for the chamfer's asymmetric kinds: the two-distance overload
// (`Add_3(Dis1, Dis2, E, F)`) and the FORWARD-use reference-face rule that
// makes `reverse` mean one stable side of an edge.
//
// A manifold edge is used FORWARD in exactly one of its two faces' wires and
// REVERSED in the other, so "the FORWARD face" is topological and does not
// depend on OCCT's face order. The tests below read the rule's answer off the
// pre-modifier shape and then assert the leg lands on that geometric face.
//
// Skips when the OCC build is absent (`just install-occ` provisions it).

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeBoxAt, makeCylinder, faceArea, faceNormal } from '../primitives'
import { volumeOf, booleanWithDiff } from '../booleans'
import { exploreEdges, exploreFaces, applyChamferWithLineage, chamferReferenceFace } from '../edgeModifier'
import { noProgress } from '../defaultArgs'
import type { OccModule, OccOrientedShape, OccShape, OccSubShape } from '../occTypes'
import type { Vec3 } from '../primitives'

const oc = await loadOcc()

interface AdjacentUse {
  face: OccShape
  // Whether the face's wire uses the edge REVERSED.
  reverse: boolean
}

/** The faces that hold `edge`, each with the orientation the edge carries in
 *  that face's wire (the same question `chamferReferenceFace` asks). */
function adjacentFaceUses(
  occ: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edge: OccShape,
): AdjacentUse[] {
  const reversed = occ.TopAbs_Orientation.TopAbs_REVERSED.value
  const out: AdjacentUse[] = []
  for (const face of exploreFaces(occ, scope, shape)) {
    for (const fe of exploreEdges(occ, scope, face)) {
      if (!(fe as OccSubShape).IsSame(edge as OccSubShape)) continue
      out.push({ face, reverse: (fe as OccOrientedShape).Orientation_1().value === reversed })
      break
    }
  }
  return out
}

/** The area of the face whose outward normal is `normal` (the adjacent faces of
 *  a box keep that normal across a chamfer), or null when none matches. */
function areaWithNormal(
  occ: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  normal: Vec3,
): number | null {
  for (const face of exploreFaces(occ, scope, shape)) {
    const n = faceNormal(occ, scope, face)
    if (Math.abs(n[0] - normal[0]) < 1e-6 && Math.abs(n[1] - normal[1]) < 1e-6 && Math.abs(n[2] - normal[2]) < 1e-6) {
      return faceArea(occ, scope, face)
    }
  }
  return null
}

function firstEdge(occ: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  const edge = exploreEdges(occ, scope, shape)[0]
  if (edge === undefined) throw new Error('shape has no edges')
  return edge
}

/** A leg's area on a 10 x 10 face after a chamfer of `leg` along 10 mm. */
const legFaceArea = (leg: number): number => 100 - leg * 10

/** The edge whose midpoint is `point`, or null. A rebuild can permute the edge
 *  list, so the geometry is the only stable handle on the transferred edge. */
function edgeAtMidpoint(occ: OccModule, scope: DisposeScope, shape: OccShape, point: Vec3): OccShape {
  for (const edge of exploreEdges(occ, scope, shape)) {
    const curve = scope.track(new occ.BRepAdaptor_Curve_2(edge))
    const mid = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2)
    const at: Vec3 = [mid.X(), mid.Y(), mid.Z()]
    mid.delete()
    if (Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]) < 1e-6) return edge
  }
  throw new Error('no edge at the transferred midpoint')
}

function edgeMidpoint(occ: OccModule, scope: DisposeScope, edge: OccShape): Vec3 {
  const curve = scope.track(new occ.BRepAdaptor_Curve_2(edge))
  const mid = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2)
  const at: Vec3 = [mid.X(), mid.Y(), mid.Z()]
  mid.delete()
  return at
}

describe.skipIf(!oc)('chamfer asymmetric kinds (real OCC)', () => {
  it('Add_3(Dis1, Dis2, E, F) removes 0.5 * d1 * d2 * L', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const edge = firstEdge(occ, scope, box)
      const uses = adjacentFaceUses(occ, scope, box, edge)
      expect(uses.length).toBe(2)
      const maker = new occ.BRepFilletAPI_MakeChamfer(box) as unknown as {
        Add_3(d1: number, d2: number, edge: OccShape, face: OccShape): void
        Build(progress: unknown): void
        IsDone(): boolean
        Shape(): OccShape
      }
      maker.Add_3(1, 2, edge, uses[0].face)
      maker.Build(noProgress(occ))
      expect(maker.IsDone()).toBe(true)
      expect(volumeOf(occ, scope, maker.Shape())).toBeCloseTo(1000 - 10, 3)
    } finally {
      scope.dispose()
    }
  })

  it('two_distance puts d1 on the FORWARD face and d2 on the other', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const edge = firstEdge(occ, scope, box)
      const uses = adjacentFaceUses(occ, scope, box, edge)
      const forward = uses.find((u) => !u.reverse)!.face
      const other = uses.find((u) => u.reverse)!.face
      const nf = faceNormal(occ, scope, forward)
      const no = faceNormal(occ, scope, other)

      const res = applyChamferWithLineage(occ, scope, box, { kind: 'two_distance', distance: 1, distance2: 2 }, [edge])
      expect(res.success).toBe(true)
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(990, 3)
      expect(areaWithNormal(occ, scope, res.shape, nf)).toBeCloseTo(legFaceArea(1), 3)
      expect(areaWithNormal(occ, scope, res.shape, no)).toBeCloseTo(legFaceArea(2), 3)
    } finally {
      scope.dispose()
    }
  })

  it('reverse swaps the two_distance legs between the same faces', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const edge = firstEdge(occ, scope, box)
      const uses = adjacentFaceUses(occ, scope, box, edge)
      const forward = uses.find((u) => !u.reverse)!.face
      const other = uses.find((u) => u.reverse)!.face
      const nf = faceNormal(occ, scope, forward)
      const no = faceNormal(occ, scope, other)

      const res = applyChamferWithLineage(
        occ, scope, box, { kind: 'two_distance', distance: 1, distance2: 2, reverse: true }, [edge],
      )
      expect(res.success).toBe(true)
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(990, 3)
      expect(areaWithNormal(occ, scope, res.shape, nf)).toBeCloseTo(legFaceArea(2), 3)
      expect(areaWithNormal(occ, scope, res.shape, no)).toBeCloseTo(legFaceArea(1), 3)
    } finally {
      scope.dispose()
    }
  })

  it('angle_distance reverse swaps the distance leg and the tan(angle) leg', () => {
    const occ = oc!
    const scope = new DisposeScope()
    const leg2 = Math.tan((30 * Math.PI) / 180)
    const removed = 0.5 * 1 * leg2 * 10
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const edge = firstEdge(occ, scope, box)
      const uses = adjacentFaceUses(occ, scope, box, edge)
      const nf = faceNormal(occ, scope, uses.find((u) => !u.reverse)!.face)
      const no = faceNormal(occ, scope, uses.find((u) => u.reverse)!.face)
      const params = { kind: 'angle_distance' as const, distance: 1, angleDeg: 30 }

      const plain = applyChamferWithLineage(occ, scope, box, params, [edge])
      expect(plain.success).toBe(true)
      expect(volumeOf(occ, scope, plain.shape)).toBeCloseTo(1000 - removed, 3)
      expect(areaWithNormal(occ, scope, plain.shape, nf)).toBeCloseTo(legFaceArea(1), 3)
      expect(areaWithNormal(occ, scope, plain.shape, no)).toBeCloseTo(legFaceArea(leg2), 3)

      const reversed = applyChamferWithLineage(occ, scope, box, { ...params, reverse: true }, [edge])
      expect(reversed.success).toBe(true)
      expect(volumeOf(occ, scope, reversed.shape)).toBeCloseTo(1000 - removed, 3)
      expect(areaWithNormal(occ, scope, reversed.shape, nf)).toBeCloseTo(legFaceArea(leg2), 3)
      expect(areaWithNormal(occ, scope, reversed.shape, no)).toBeCloseTo(legFaceArea(1), 3)
    } finally {
      scope.dispose()
    }
  })

  it('the reference face does not depend on the face list order', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const faces = exploreFaces(occ, scope, box)
      const referenceFace = chamferReferenceFace(occ)
      const forward = { scope, faces }
      const backward = { scope, faces: [...faces].reverse() }
      for (const edge of exploreEdges(occ, scope, box)) {
        const uses = adjacentFaceUses(occ, scope, box, edge)
        const forwardUse = uses.find((u) => !u.reverse)!
        const reversedUse = uses.find((u) => u.reverse)!
        const a = referenceFace(edge, forward, false)
        const b = referenceFace(edge, backward, false)
        expect(a).not.toBeNull()
        expect((a as OccSubShape).IsSame(b as OccSubShape)).toBe(true)
        expect((a as OccSubShape).IsSame(forwardUse.face as OccSubShape)).toBe(true)
        const flipped = referenceFace(edge, forward, true)
        expect((flipped as OccSubShape).IsSame(reversedUse.face as OccSubShape)).toBe(true)
      }
    } finally {
      scope.dispose()
    }
  })

  it('a no-op boolean rebuild lands the leg on the same geometric face', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const edge = firstEdge(occ, scope, box)
      const nf = faceNormal(occ, scope, adjacentFaceUses(occ, scope, box, edge).find((u) => !u.reverse)!.face)
      const midpoint = edgeMidpoint(occ, scope, edge)
      // A cut by a disjoint tool is a no-op on the geometry but rebuilds the
      // body through the boolean path: an independent construction whose face
      // list is the boolean's, not makeBox's. The leg must land on the same
      // geometric face still.
      const far = makeBoxAt(occ, scope, [100, 100, 100], 1, 1, 1)
      const rebuilt = scope.track(booleanWithDiff(occ, scope, box, far, 'cut').shape)
      const rebuiltEdge = edgeAtMidpoint(occ, scope, rebuilt, midpoint)
      const res = applyChamferWithLineage(occ, scope, rebuilt, { kind: 'two_distance', distance: 1, distance2: 2 }, [rebuiltEdge])
      expect(res.success).toBe(true)
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(990, 3)
      expect(areaWithNormal(occ, scope, res.shape, nf)).toBeCloseTo(legFaceArea(1), 3)
    } finally {
      scope.dispose()
    }
  })

  it('ignores reverse on a seam edge and does not throw', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      const cylinder = makeCylinder(occ, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const faces = exploreFaces(occ, scope, cylinder)
      const ctx = { scope, faces }
      const referenceFace = chamferReferenceFace(occ)
      const seam = exploreEdges(occ, scope, cylinder).find((edge) => {
        const uses = adjacentFaceUses(occ, scope, cylinder, edge)
        return uses.length > 0 && uses.every((u) => (u.face as OccSubShape).IsSame(uses[0].face as OccSubShape))
      })
      expect(seam).toBeDefined()
      const edge = seam!
      const plain = referenceFace(edge, ctx, false)
      const reversed = referenceFace(edge, ctx, true)
      expect(plain).not.toBeNull()
      expect((plain as OccSubShape).IsSame(reversed as OccSubShape)).toBe(true)
      expect(() =>
        applyChamferWithLineage(occ, scope, cylinder, { kind: 'angle_distance', distance: 1, angleDeg: 45 }, [edge]),
      ).not.toThrow()
      expect(() =>
        applyChamferWithLineage(
          occ, scope, cylinder, { kind: 'angle_distance', distance: 1, angleDeg: 45, reverse: true }, [edge],
        ),
      ).not.toThrow()
    } finally {
      scope.dispose()
    }
  })

  it('a two_distance chamfer with no distance2 builds symmetric', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const edge = firstEdge(occ, scope, box)
      const uses = adjacentFaceUses(occ, scope, box, edge)
      const nf = faceNormal(occ, scope, uses.find((u) => !u.reverse)!.face)
      const no = faceNormal(occ, scope, uses.find((u) => u.reverse)!.face)
      const res = applyChamferWithLineage(occ, scope, box, { kind: 'two_distance', distance: 1 }, [edge])
      expect(res.success).toBe(true)
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(995, 3)
      expect(areaWithNormal(occ, scope, res.shape, nf)).toBeCloseTo(legFaceArea(1), 3)
      expect(areaWithNormal(occ, scope, res.shape, no)).toBeCloseTo(legFaceArea(1), 3)
    } finally {
      scope.dispose()
    }
  })
})
