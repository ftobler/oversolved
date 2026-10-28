// @vitest-environment node
//
// The half-space box the split leaf cuts with, against real OCC. The box is a
// finite stand-in for an infinite half-space, so the two things that can go
// wrong are geometric: the base not lying in the plane, and the box not being
// big enough around a body far from the origin. Skips when OCC is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBoxAt, readSolidVertices, type Vec3 } from '../primitives'
import { makeHalfSpaceBox } from '../halfSpace'
import type { OccShape, OccSubShape, OccXYZ } from '../occTypes'

const loadedOcc = await loadOcc()
const hasOcc = loadedOcc !== null
const oc = loadedOcc!

function faceVertices(scope: DisposeScope, face: OccShape): Vec3[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const out: Vec3[] = []
  const seen: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const vertex = scope.track(oc.TopoDS.Vertex_1(scope.track(exp.Current()))) as unknown as OccSubShape
    // The explorer visits a shared vertex once per edge, so dedupe by identity.
    if (seen.some((s) => vertex.IsSame(s))) continue
    seen.push(vertex)
    const pnt = scope.track(oc.BRep_Tool.Pnt(vertex))
    out.push([pnt.X(), pnt.Y(), pnt.Z()])
  }
  return out
}

function isInside(scope: DisposeScope, solid: OccShape, p: Vec3): boolean {
  const pnt = scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2])) as unknown as OccXYZ
  const classifier = scope.track(new oc.BRepClass3d_SolidClassifier_3(solid, pnt, 1e-7))
  // ON is a body point sitting exactly on the box's plane face, which is the
  // boundary of the half-space, not outside it.
  return classifier.State().value !== oc.TopAbs_State.TopAbs_OUT.value
}

function distanceToPlane(p: Vec3, origin: Vec3, normal: Vec3): number {
  return (p[0] - origin[0]) * normal[0] + (p[1] - origin[1]) * normal[1] + (p[2] - origin[2]) * normal[2]
}

function faceIsSame(shape: OccShape, candidate: OccShape): boolean {
  const E = oc.TopAbs_ShapeEnum
  const exp = new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE)
  let same = false
  for (; exp.More(); exp.Next()) {
    if ((exp.Current() as OccSubShape).IsSame(candidate as OccSubShape)) same = true
  }
  exp.delete()
  return same
}

describe.skipIf(!hasOcc)('makeHalfSpaceBox', () => {
  it('puts the base in the plane and the box on the normal side', () => {
    const scope = new DisposeScope()
    try {
      const body = makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10)
      const origin: Vec3 = [0, 5, 0]
      const normal: Vec3 = [0, 1, 0]
      const { shape, base } = makeHalfSpaceBox(oc, scope, origin, normal, body)

      const baseVerts = faceVertices(scope, base)
      expect(baseVerts).toHaveLength(4)
      for (const p of baseVerts) expect(Math.abs(distanceToPlane(p, origin, normal))).toBeLessThan(1e-9)

      const boxVerts = readSolidVertices(oc, scope, shape)
      expect(boxVerts.length).toBeGreaterThan(0)
      for (const p of boxVerts) expect(distanceToPlane(p, origin, normal)).toBeGreaterThanOrEqual(-1e-9)
    } finally {
      scope.dispose()
    }
  })

  it('reports the base as a face of the prism, by construction', () => {
    const scope = new DisposeScope()
    try {
      const body = makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10)
      const { shape, base } = makeHalfSpaceBox(oc, scope, [0, 3, 0], [0, 1, 0], body)
      expect(faceIsSame(shape, base)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('covers a body a long way from the origin', () => {
    const scope = new DisposeScope()
    try {
      const body = makeBoxAt(oc, scope, [1e4, -1e4, 5e3], 10, 10, 10)
      // The plane of the body's bottom face: everything above it must be covered.
      const origin: Vec3 = [1e4 + 5, -1e4, 5e3 + 5]
      const { shape } = makeHalfSpaceBox(oc, scope, origin, [0, 1, 0], body)
      for (const p of readSolidVertices(oc, scope, body)) expect(isInside(scope, shape, p)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('covers the body when the plane origin sits 1e3 away in-plane', () => {
    const scope = new DisposeScope()
    try {
      const body = makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10)
      // The plane y = 0 is the same plane whatever in-plane point names it.
      const origin: Vec3 = [1000, 0, -1000]
      const { shape } = makeHalfSpaceBox(oc, scope, origin, [0, 1, 0], body)
      for (const p of readSolidVertices(oc, scope, body)) expect(isInside(scope, shape, p)).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})
