// Gated real-OCC tests for extrude "up to" termination (feature: extrude-up-to).
// Reuses the box + edge-loop-profile harness: a coplanar face at z=0, extruded
// up to a plane offset along its normal, must terminate exactly on that plane.
// Skips when OCC.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox, makePrism, faceCentroid, faceNormal, type Vec3 } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { faceGeometryHash } from '../geomHash'
import { solidToEdges } from '../occ/tessellation'
import { resolveProfileEdges, edgesToProfileFace } from './edgeProfile'
import { trimAtPlane } from './upTo'
import { solveExtrude } from './extrude'
import type { Repository } from '../query'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'

const oc = await loadOcc()

function repoReturning(entry: unknown): Repository {
  return { query: () => entry } as unknown as Repository
}

describe.skipIf(!oc)('extrude up-to termination (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function makeBoxBody(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const box = makeBox(occ, scope, 10, 10, 10)
    const E = occ.TopAbs_ShapeEnum
    const lineage: Record<string, string[]> = {}
    const exp = scope.track(new occ.TopExp_Explorer_2(box, E.TopAbs_FACE, E.TopAbs_SHAPE))
    let i = 0
    for (; exp.More(); exp.Next()) {
      const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
      lineage[faceGeometryHash(faceCentroid(occ, scope, f), faceNormal(occ, scope, f))] = [`@face_${i++}`]
    }
    return {
      body_b: {
        id: 'body_b', created_by: 'ex1', modified_by: [],
        shape: table.register(scope.detach(box), 'ex1'), sketch_id: 'sk',
        brep_diff: null, profile_queries: [], face_lineage: lineage, edge_lineage: {},
      },
    }
  }

  function bottomLoop(table: HandleTable, body: Body): string[] {
    const { edges, edge_queries } = solidToEdges(occ, table, body.shape!, {
      createdBy: body.created_by, bodyId: body.id,
      profileQueries: body.profile_queries,
      edgeAncestry: body.edge_ancestry ?? null, edgeNames: body.edge_names ?? null,
    })
    const out: string[] = []
    for (let i = 0; i < edges.length; i++) {
      const ed = edges[i]
      if (ed.kind === 'line' && Math.abs(ed.start[2]) < 1e-6 && Math.abs(ed.end[2]) < 1e-6) {
        out.push(edge_queries[i])
      }
    }
    return out
  }

  it('trimAtPlane truncates an over-length prism exactly at the plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, bottomLoop(table, bodyStore.body_b), bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const prism = makePrism(occ, scope, face, n, 1e4)
      // Plane offset 7 along the face normal from the z=0 profile.
      const origin: Vec3 = [0, 0, 7 * n[2]]
      const trimmed = trimAtPlane(occ, scope, prism, { origin, normal: n }, n)
      expect(volumeOf(occ, scope, trimmed)).toBeCloseTo(700, 2)
    } finally {
      scope.dispose()
    }
  })

  it('terminates on a plane NOT parallel to the profile (slanted cut)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      // z=0 square, x,y in [0,10].
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, bottomLoop(table, bodyStore.body_b), bodyStore))
      const dir: Vec3 = [0, 0, 1]
      const prism = makePrism(occ, scope, face, dir, 1e4)
      // Plane through z=5 at y=0, tilted 45deg in y: z_top = 5 + y. Whole profile
      // is below it, so the result is a wedge, not a box.
      const s = Math.SQRT1_2
      const trimmed = trimAtPlane(occ, scope, prism, { origin: [0, 0, 5], normal: [0, -s, s] }, dir)
      // Volume = 10 * integral_0^10 (5 + y) dy = 10 * (50 + 50) = 1000.
      expect(volumeOf(occ, scope, trimmed)).toBeCloseTo(1000, 1)
    } finally {
      scope.dispose()
    }
  })

  it('solveExtrude up_to ignores blind distance and terminates at the plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      // Find the profile normal so the up-to plane sits 7 ahead of it.
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, loop, bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const c = faceCentroid(occ, scope, face)
      const planeEntry = { origin: [c[0] + 7 * n[0], c[1] + 7 * n[1], c[2] + 7 * n[2]], normal: n }

      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 999, termination: 'up_to', up_to: 'plane_q', operation: 'new' } },
        repoReturning(planeEntry), bodyStore,
      )
      expect(result.status).toBe('ok')
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(700, 2)  // 100 area * 7, not 100 * 999
    } finally {
      scope.dispose()
    }
  })

  it('auto-reverses when the up_to target is behind the extrude direction', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, loop, bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const c = faceCentroid(occ, scope, face)
      // Plane 5 behind the profile along the extrude direction: the pick, not the
      // direction toggle, decides which way the material grows.
      const planeEntry = { origin: [c[0] - 5 * n[0], c[1] - 5 * n[1], c[2] - 5 * n[2]], normal: n }
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 999, termination: 'up_to', up_to: 'plane_q', operation: 'new' } },
        repoReturning(planeEntry), bodyStore,
      )
      expect(result.status).toBe('ok')
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(500, 2)  // 100 area * 5, swept backwards
    } finally {
      scope.dispose()
    }
  })

  it('errors when the up_to target passes through the profile', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const face = edgesToProfileFace(occ, scope, resolveProfileEdges(occ, scope, table, loop, bodyStore))
      const n = faceNormal(occ, scope, face) as Vec3
      const c = faceCentroid(occ, scope, face)
      const planeEntry = { origin: [c[0], c[1], c[2]], normal: n }
      expect(() =>
        solveExtrude(
          occ, scope, table,
          { id: 'ex2', extrude: { sketch: loop, distance: 5, termination: 'up_to', up_to: 'plane_q', operation: 'new' } },
          repoReturning(planeEntry), bodyStore,
        ),
      ).toThrow(/no distance to extrude/)
    } finally {
      scope.dispose()
    }
  })

  it('falls back to blind distance with a warning when up_to does not resolve', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const loop = bottomLoop(table, bodyStore.body_b)
      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: loop, distance: 3, termination: 'up_to', up_to: 'missing_q', operation: 'new' } },
        repoReturning(null), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toMatch(/did not resolve/)
      const vol = volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_ex2.shape!))
      expect(vol).toBeCloseTo(300, 2)  // blind 100 * 3
    } finally {
      scope.dispose()
    }
  })
})
