// @vitest-environment node
//
// Gated real-OCC probe (wave 10, D1): does an identity BRepBuilderAPI_Transform
// share the source TShape? copyShape's docstring used to claim it does and that a
// later in-place fillet/boolean frees the shared TShape underneath a snapshot.
// First run (2026-09-05) refuted that: copy=true on the identity transform is a
// real rebuild (IsPartner/IsSame false against the source, and a fillet of the
// source plus the old-handle release leaves the copy's volume and face count
// unchanged). The two probes below are the recorded answer. Test 2 is kept in
// its own `it` after test 1 so a fault could not have masked the identity result.
//
// Skips when opencascade.js is not installed (npm run occ:install).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { HandleTable } from './handleTable'
import { DisposeScope } from './disposeScope'
import { makeBox, readSolidVertices, type Vec3 } from './primitives'
import { transformCopyWithMapping } from './transformLineage'
import { makeRigidTrsf, applyTransformShape, transformCopy, makeRotationTrsf, makeMirrorTrsf } from './transforms'
import { applyFilletWithLineage } from './edgeModifier'
import { volumeOf } from './booleans'
import type { OccModule, OccShape, OccSubShape } from './occTypes'

const oc = await loadOcc()

function countFaces(occ2: OccModule, scope: DisposeScope, shape: OccShape): number {
  const E = occ2.TopAbs_ShapeEnum
  const exp = scope.track(new occ2.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  let n = 0
  for (; exp.More(); exp.Next()) n++
  return n
}

function firstEdge(occ2: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  const E = occ2.TopAbs_ShapeEnum
  const exp = scope.track(new occ2.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  if (!exp.More()) throw new Error('no edge in shape')
  return scope.track(occ2.TopoDS.Edge_1(exp.Current()))
}

describe.skipIf(!oc)('identity transform sharing (real OCC, D1)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  it('an identity BRepBuilderAPI_Transform does NOT share the source TShape (copy=true rebuilds)', () => {
    const table = new HandleTable()
    const scope = new DisposeScope()
    try {
      const hA = table.register(makeBox(occ, scope, 10, 10, 10), 'a')
      const A = table.get<OccShape>(hA)
      const identity = scope.track(new occ.gp_Trsf_1())
      const { shape: B } = transformCopyWithMapping(occ, scope, A, identity)
      // Probe: IsPartner ignores orientation and Location, so under Moved-copy
      // sharing it reads true. First run (2026-09-05) observed both false: an
      // identity transform with copy=true rebuilds the TShape tree, it does NOT
      // alias the source (the docstring's old sharing claim was wrong).
      const shared = (B as OccSubShape).IsPartner(A as OccSubShape)
      const same = (B as OccSubShape).IsSame(A as OccSubShape)
      expect({ shared, same }).toEqual({ shared: false, same: false })
      // Oracle sanity: the SAME transform with copy=false must alias the source
      // (IsPartner true), proving the negative above is a real rebuild, not a
      // binding that returns fresh copies for every call.
      const moved = scope.track(new occ.BRepBuilderAPI_Transform_2(A, identity, false)).Shape()
      expect((moved as OccSubShape).IsPartner(A as OccSubShape)).toBe(true)
      table.release(hA)
      table.assertNoLeaks()
    } finally {
      scope.dispose()
    }
  })

  it('a fillet of the source plus its old-handle release leaves the identity copy intact', () => {
    const table = new HandleTable()
    const scope = new DisposeScope()
    try {
      const hA = table.register(makeBox(occ, scope, 10, 10, 10), 'a')
      const A = table.get<OccShape>(hA)
      const identity = scope.track(new occ.gp_Trsf_1())
      const { shape: B } = transformCopyWithMapping(occ, scope, A, identity)
      const hB = table.register(B, 'b')
      const beforeVol = volumeOf(occ, scope, B)
      const beforeFaces = countFaces(occ, scope, B)
      const res = applyFilletWithLineage(occ, scope, A, 1.0, [firstEdge(occ, scope, A)])
      expect(res.success).toBe(true)
      table.release(hA)
      // A's old handle is gone. Under sharing this would free the TShape
      // underneath B and the reads below would fault or change; first run
      // (2026-09-05) observed them unchanged (999.999... -> 999.999..., 6 -> 6),
      // consistent with B being a real rebuild.
      const afterVol = volumeOf(occ, scope, B)
      const afterFaces = countFaces(occ, scope, B)
      expect(afterVol).toBeCloseTo(beforeVol, 6)
      expect(afterFaces).toBe(beforeFaces)
      table.release(hB)
      table.assertNoLeaks()
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!oc)('trsf composition order (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  function vertexAt(verts: Vec3[], target: Vec3): boolean {
    return verts.some((v) => v.every((c, i) => Math.abs(c - target[i]) < 1e-6))
  }

  it('makeRigidTrsf rotates the point before translating it', () => {
    // The documented convention is `p -> rotate(q, p) + t`. Multiply order is
    // load-bearing: (A*B)(p) == A(B(p)), so the translation has to be multiplied
    // in first or the box is rotated about the world origin after being carried
    // out to its placed position.
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 2, 2, 2)
      const h = Math.SQRT1_2  // 90 deg about Z
      const trsf = makeRigidTrsf(occ, scope, { tx: 10, ty: 0, tz: 0, qx: 0, qy: 0, qz: h, qw: h })
      const placed = transformCopy(occ, scope, box, trsf)
      const verts = readSolidVertices(occ, scope, placed)
      // (2,0,0) -> R90z (0,2,0) -> +t (10,2,0).
      expect(vertexAt(verts, [10, 2, 0])).toBe(true)
      // Translation applied before the rotation would put it at (0,10,0).
      expect(vertexAt(verts, [0, 10, 0])).toBe(false)
    } finally {
      scope.dispose()
    }
  })

  it('applyTransformShape leaves the translation outermost over scale and rotation', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 2, 2, 2)
      const shaped = applyTransformShape(occ, scope, box, {
        translation: [10, 0, 0],
        rotationAxisOrigin: [0, 0, 0],
        rotationAxisDirection: [0, 0, 1],
        rotationAngleDeg: 90,
        scale: 2,
        scaleCenter: [0, 0, 0],
      })
      const verts = readSolidVertices(occ, scope, shaped)
      // (2,0,0) -> scale x2 (4,0,0) -> R90z (0,4,0) -> +t (10,4,0).
      expect(vertexAt(verts, [10, 4, 0])).toBe(true)
      // A translation applied first would land it at (0,24,0).
      expect(vertexAt(verts, [0, 24, 0])).toBe(false)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a zero-length rotation axis before touching the kernel', () => {
    const scope = new DisposeScope()
    try {
      expect(() => makeRotationTrsf(occ, scope, [0, 0, 0], [0, 0, 0], 1)).toThrow(
        /rotation axis direction must be a non-zero vector/,
      )
    } finally {
      scope.dispose()
    }
  })

  it('refuses a zero-length mirror normal before touching the kernel', () => {
    const scope = new DisposeScope()
    try {
      expect(() => makeMirrorTrsf(occ, scope, [0, 0, 0], [0, 0, 0])).toThrow(
        /mirror normal must be a non-zero vector/,
      )
    } finally {
      scope.dispose()
    }
  })
})