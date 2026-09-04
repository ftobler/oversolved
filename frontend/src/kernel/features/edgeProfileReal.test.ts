// Gated real-OCC tests for B-rep edge profiles (feature: extrude-brep-profile).
// Picks the four coplanar bottom edges of a box, assembles them into a profile
// face, and extrudes -- both via the helpers directly and end to end through
// solveExtrude. Skips when OCC.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox, makePrism, faceNormal, type Vec3 } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { Repository } from '../query'
import { solidToEdges } from '../occ/tessellation'
import { solveExtrude } from './extrude'
import { resolveProfileEdges, edgesToProfileFace, resolveEdgeProfileFace } from './edgeProfile'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('extrude profile from B-rep edges (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function makeBoxBody(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const box = makeBox(occ, scope, 10, 10, 10)
    return {
      body_b: {
        id: 'body_b',
        created_by: 'ex1',
        modified_by: [],
        shape: table.register(box, 'ex1'),
        sketch_id: 'sk',
        brep_diff: null,
        profile_queries: [],
      },
    }
  }

  // Ancestry queries for the four edges whose endpoints both lie at z == zPlane.
  function edgeLoopAtZ(
    table: HandleTable,
    body: Body,
    zPlane: number,
  ): string[] {
    const { edges, edge_queries } = solidToEdges(occ, table, body.shape!, {
      createdBy: body.created_by,
      bodyId: body.id,
      profileQueries: body.profile_queries,
      edgeAncestry: body.edge_ancestry ?? null,
      edgeNames: body.edge_names ?? null,
    })
    const out: string[] = []
    for (let i = 0; i < edges.length; i++) {
      const ed = edges[i]
      if (ed.kind !== 'line') continue
      if (Math.abs(ed.start[2] - zPlane) < 1e-6 && Math.abs(ed.end[2] - zPlane) < 1e-6) {
        out.push(edge_queries[i])
      }
    }
    return out
  }

  it('assembles four coplanar box edges into a profile face and extrudes it', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const bottom = edgeLoopAtZ(table, bodyStore.body_b, 0)
      expect(bottom.length).toBe(4)

      const edges = resolveProfileEdges(occ, scope, table, bottom, bodyStore)
      expect(edges.length).toBe(4)

      const face = edgesToProfileFace(occ, scope, edges)
      const n = faceNormal(occ, scope, face)
      const prism = makePrism(occ, scope, face, n as Vec3, 5)
      // 10x10 face swept 5 deep -> 500.
      expect(volumeOf(occ, scope, prism)).toBeCloseTo(500, 3)
    } finally {
      scope.dispose()
    }
  })

  it('solveExtrude builds a new body from an edge-loop profile', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const bottom = edgeLoopAtZ(table, bodyStore.body_b, 0)

      const result = solveExtrude(
        occ, scope, table,
        { id: 'ex2', extrude: { sketch: bottom, distance: 5, operation: 'new' } },
        new Repository(), bodyStore,
      )
      expect(result.status).toBe('ok')
      const newBody = bodyStore.body_ex2
      expect(newBody).toBeDefined()
      expect(volumeOf(occ, scope, table.get<OccShape>(newBody.shape!))).toBeCloseTo(500, 3)
    } finally {
      scope.dispose()
    }
  })

  it('rejects a non-coplanar / open edge set', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBoxBody(scope, table)
      const bottom = edgeLoopAtZ(table, bodyStore.body_b, 0)
      const top = edgeLoopAtZ(table, bodyStore.body_b, 10)
      // One bottom edge + one top edge: not connected, not a closed coplanar loop.
      expect(() =>
        resolveEdgeProfileFace(occ, scope, table, [bottom[0], top[0]], bodyStore),
      ).toThrow()
    } finally {
      scope.dispose()
    }
  })

  it('errors on a gapped coplanar loop instead of building a shortened face', () => {
    // A raw MakeWire silently drops an edge whose joint gap exceeds its
    // confusion tolerance and stays done, so the face used to be built off the
    // surviving open U of edges with no error at all. The wire must fail loud
    // (makeWire's connectivity guard) rather than extrude a short profile.
    const scope = new DisposeScope()
    try {
      const GAP = 0.5
      const pnt = (x: number, y: number) =>
        scope.track(new occ.gp_Pnt_3(x, y, 0))
      const edge = (aX: number, aY: number, bX: number, bY: number) =>
        scope.track(new occ.BRepBuilderAPI_MakeEdge_3(pnt(aX, aY), pnt(bX, bY))).Edge()
      const e1 = edge(0, 0, 1, 0)
      const e2 = edge(1, 0, 1, 1)
      // Deliberate gap: this edge starts at (1+GAP, 1) instead of (1, 1).
      const e3 = edge(1 + GAP, 1, 0, 1)
      const e4 = edge(0, 1, 0, 0)

      expect(() => edgesToProfileFace(occ, scope, [e1, e2, e3, e4])).toThrow()
    } finally {
      scope.dispose()
    }
  })
})
