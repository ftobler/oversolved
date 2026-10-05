// @vitest-environment node
//
// Gated real-OCC test for the construction-name threading
// (query-naming-by-construction.md): a face UUID is carried across a boolean and
// across a fillet by OCC subshape identity (Modified/IsSame), NOT geometry.
// Asserts that faces the op leaves untouched keep their exact minted UUID, and
// that a fillet mints a role=fillet UUID slotted by the filleted edge's UUID.
//
// Skips when opencascade.js is absent, like the other real-OCC gates.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { extrudeProfileWithLineage } from './prismLineage'
import { booleanWithDiff } from './booleans'
import { applyFilletWithLineage } from './edgeModifier'
import { transferBooleanNames } from '../features/booleanLineage'
import { edgeGh } from './lineageHash'
import type { PlaneLike } from '../features/shared/planes'
import type { LoopEdge } from '../profileLoops'
import type { OccModule, OccShape } from './occTypes'
import type { Vec3 } from './primitives'
import {
  mintFaceUuid,
  sideFacePath,
  capFacePath,
  filletFacePath,
  toolCopyFacePath,
} from '../constructionName'

const oc = await loadOcc()

function planeAt(z: number): PlaneLike {
  return { origin: [0, 0, z], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
}

function square(x0: number, y0: number, size: number): LoopEdge[][] {
  const c: [number, number][] = [
    [x0, y0],
    [x0 + size, y0],
    [x0 + size, y0 + size],
    [x0, y0 + size],
  ]
  return [c.map((start, i) => ({ kind: 'line', id: `l${i}`, start, end: c[(i + 1) % c.length] }))]
}

function edgesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Edge_1(exp.Current())))
  return out
}

describe.skipIf(!oc)('construction-name threading through ops (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('carries a target face UUID across a fuse by subshape identity', () => {
    const scope = new DisposeScope()
    try {
      // A 10x10x10 base box (e1) and a 6x6x5 bump (e2) fused onto its top face.
      const base = extrudeProfileWithLineage(occ, scope, square(0, 0, 10), planeAt(0), [0, 0, 1] as Vec3, 10, 'sk1', 'e1')
      const bump = extrudeProfileWithLineage(occ, scope, square(2, 2, 6), planeAt(10), [0, 0, 1] as Vec3, 5, 'sk2', 'e2')

      const { shape: fused, faceOrigin } = booleanWithDiff(occ, scope, base.solid, bump.solid, 'fuse')
      const names = transferBooleanNames(occ, scope, {
        bodyShape: fused,
        faceOrigin,
        targetFaceNames: base.faceNames,
        targetFaceAncestry: base.faceAncestry,
        toolFaceNames: bump.faceNames,
        toolFaceAncestry: bump.faceAncestry,
        toolUuidScope: null,
      })
      const carried = new Set(Object.values(names.face_names))

      // The base box's bottom cap and 4 side walls are untouched by the fuse, so
      // their exact minted UUIDs must survive.
      expect(carried.has(mintFaceUuid(capFacePath('e1', 'start')))).toBe(true)
      for (let i = 0; i < 4; i++) {
        expect(carried.has(mintFaceUuid(sideFacePath('e1', `sk1/l${i}`)))).toBe(true)
      }
      // The bump's own side walls (from e2) are carried too.
      for (let i = 0; i < 4; i++) {
        expect(carried.has(mintFaceUuid(sideFacePath('e2', `sk2/l${i}`)))).toBe(true)
      }
    } finally {
      scope.dispose()
    }
  })

  it('re-mints a KEPT tool\'s UUIDs onto the target so the two never collide', () => {
    // `keep_tools` leaves the tool body in the store still carrying its own face
    // UUIDs. Handing them to the target verbatim put one UUID on two live faces,
    // and the resolver's UUID tier then refused every pick of either with
    // "collision by construction" (bugreports/20260902_2256_face_not_extruding).
    const scope = new DisposeScope()
    try {
      const base = extrudeProfileWithLineage(occ, scope, square(0, 0, 10), planeAt(0), [0, 0, 1] as Vec3, 10, 'sk1', 'e1')
      const bump = extrudeProfileWithLineage(occ, scope, square(2, 2, 6), planeAt(10), [0, 0, 1] as Vec3, 5, 'sk2', 'e2')
      const { shape: fused, faceOrigin } = booleanWithDiff(occ, scope, base.solid, bump.solid, 'fuse')

      const kept = transferBooleanNames(occ, scope, {
        bodyShape: fused,
        faceOrigin,
        targetFaceNames: base.faceNames,
        targetFaceAncestry: base.faceAncestry,
        toolFaceNames: bump.faceNames,
        toolFaceAncestry: bump.faceAncestry,
        toolUuidScope: 'bool1',
      })
      const carried = new Set(Object.values(kept.face_names))

      // Not one of the surviving tool's own UUIDs appears on the target.
      for (const toolUuid of Object.values(bump.faceNames)) {
        expect(carried.has(toolUuid)).toBe(false)
      }
      // They are re-minted, not dropped: each tool face still has a stable
      // identity on the target, derived from the tool's UUID and this boolean.
      for (let i = 0; i < 4; i++) {
        const toolUuid = mintFaceUuid(sideFacePath('e2', `sk2/l${i}`))
        expect(carried.has(mintFaceUuid(toolCopyFacePath(toolUuid, 'bool1')))).toBe(true)
      }
      // The target's own faces are untouched by the re-mint.
      expect(carried.has(mintFaceUuid(capFacePath('e1', 'start')))).toBe(true)

      // A consuming boolean keeps the verbatim carry-over: its tool is gone, so
      // the inherited UUID is unique and re-minting would only churn it.
      const consumed = transferBooleanNames(occ, scope, {
        bodyShape: fused,
        faceOrigin,
        targetFaceNames: base.faceNames,
        targetFaceAncestry: base.faceAncestry,
        toolFaceNames: bump.faceNames,
        toolFaceAncestry: bump.faceAncestry,
        toolUuidScope: null,
      })
      const consumedCarried = new Set(Object.values(consumed.face_names))
      expect(consumedCarried.has(mintFaceUuid(sideFacePath('e2', 'sk2/l0')))).toBe(true)

      // Ancestry follows the re-minted UUID -- and carries the tool face's own
      // tokens, not an empty list. Keying that lookup on the re-minted UUID
      // instead of the source silently yields `[]`, which leaves the ancestral
      // fallback tier with nothing and sends the face to the body-wide
      // profile_queries bucket (builder.ts), so `toBeDefined` is not enough.
      let withTokens = 0
      for (const toolUuid of Object.values(bump.faceNames)) {
        const reminted = mintFaceUuid(toolCopyFacePath(toolUuid, 'bool1'))
        if (!carried.has(reminted)) continue  // face consumed by the fuse
        expect(kept.face_ancestry[reminted]).toEqual(bump.faceAncestry[toolUuid])
        if ((kept.face_ancestry[reminted] ?? []).length > 0) withTokens++
      }
      // And at least one of them really has tokens -- the wrong lookup key
      // satisfies the equality above only by making every list empty.
      expect(withTokens).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('fillet keeps untouched face UUIDs and mints a role=fillet UUID', () => {
    const scope = new DisposeScope()
    try {
      const box = extrudeProfileWithLineage(occ, scope, square(0, 0, 10), planeAt(0), [0, 0, 1] as Vec3, 10, 'sk1', 'e1')

      // Pick one named edge to fillet.
      const edges = edgesOf(occ, scope, box.solid)
      let picked: OccShape | null = null
      let pickedUuid = ''
      for (const e of edges) {
        const gh = edgeGh(occ, scope, e)
        const u = gh !== null ? box.edgeNames[gh] : undefined
        if (u) {
          picked = e
          pickedUuid = u
          break
        }
      }
      expect(picked).not.toBeNull()

      const res = applyFilletWithLineage(occ, scope, box.solid, 1.0, [picked as OccShape], {
        createdBy: 'f1',
        faceNames: box.faceNames,
        edgeNames: box.edgeNames,
        faceAncestry: box.faceAncestry,
        edgeAncestry: box.edgeAncestry,
      })
      expect(res.success).toBe(true)
      expect(res.names).not.toBeNull()
      const carried = new Set(Object.values(res.names!.faceNames))

      // The generated fillet face is named role=fillet slotted by the edge UUID.
      expect(carried.has(mintFaceUuid(filletFacePath('f1', pickedUuid)))).toBe(true)
      // A box face not adjacent to the filleted edge keeps its UUID; the bottom
      // cap (start) survives every single-edge fillet.
      expect(carried.has(mintFaceUuid(capFacePath('e1', 'start')))).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})
