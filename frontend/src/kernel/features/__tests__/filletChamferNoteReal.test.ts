// @vitest-environment node
//
// The tangent-chain text moved from `solver_warning` to `solver_note`: OCC's
// blend continuing across a G1 joint is the geometry the pick produces, not a
// fallback, so the leaf reports it as an informational note. A real fallback
// (an up-to target that did not resolve) keeps its `solver_warning`; that case
// is pinned beside the drive reply in extrudeUpToWarningComposition.test.ts and
// upToReal.test.ts.
//
// Geometry: a 20 x 10 rounded rectangle (r2) extruded 5, whose top loop is four
// lines and four corner arcs, all tangent. One top-line pick blends the loop.
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { extrudeProfileWithLineage } from '../../occ/prismLineage'
import { solidToEdges } from '../../occ/tessellation'
import { canonicalEdges, canonicalFaces, namesToArray } from '../../occ/bodyNames'
import { ref, Repository } from '../../query'
import { solveFillet, solveChamfer } from '../filletChamfer'
import type { Body } from '../../types3d'
import type { PlaneLike } from '../shared/planes'
import type { LoopEdge } from '../../profileLoops'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()
const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

/** A 20 x 10 rounded rectangle with r2 corners, in CCW order. */
function roundedRect(): LoopEdge[] {
  return [
    { id: 'bottom', kind: 'line', start: [2, 0], end: [18, 0] },
    { id: 'br', kind: 'arc', center: [18, 2], radius: 2, angle_start_deg: 270, angle_end_deg: 360, ccw: true, start: [18, 0], end: [20, 2] },
    { id: 'right', kind: 'line', start: [20, 2], end: [20, 8] },
    { id: 'tr', kind: 'arc', center: [18, 8], radius: 2, angle_start_deg: 0, angle_end_deg: 90, ccw: true, start: [20, 8], end: [18, 10] },
    { id: 'top', kind: 'line', start: [18, 10], end: [2, 10] },
    { id: 'tl', kind: 'arc', center: [2, 8], radius: 2, angle_start_deg: 90, angle_end_deg: 180, ccw: true, start: [2, 10], end: [0, 8] },
    { id: 'left', kind: 'line', start: [0, 8], end: [0, 2] },
    { id: 'bl', kind: 'arc', center: [2, 2], radius: 2, angle_start_deg: 180, angle_end_deg: 270, ccw: true, start: [0, 2], end: [2, 0] },
  ] as unknown as LoopEdge[]
}

/** The extruded plate plus the body metadata the fillet leaf reads. */
function plate(occ: OccModule, scope: DisposeScope, table: HandleTable): Record<string, Body> {
  const res = extrudeProfileWithLineage(occ, scope, [roundedRect()], XY, [0, 0, 1], 5, 'sk1', 'ex1')
  const shape = scope.track(res.solid as OccShape)
  const handle = table.register(shape, 'ex1')
  const body: Body = {
    id: 'body_ex1',
    created_by: 'ex1',
    modified_by: [],
    shape: handle,
    sketch_id: 'sk1',
    brep_diff: null,
    profile_queries: [ref('sk1')],
    face_uuids: namesToArray(canonicalFaces(occ, scope, shape), res.faceNames),
    edge_uuids: namesToArray(canonicalEdges(occ, scope, shape), res.edgeNames),
    face_ancestry: res.faceAncestry,
    edge_ancestry: res.edgeAncestry,
  }
  return { body_ex1: body }
}

/** The query of the top straight edge (y = 10, z = 5): one edge of the loop. */
function topEdgeQuery(
  occ: OccModule,
  table: HandleTable,
  bodyStore: Record<string, Body>,
): string {
  const body = bodyStore.body_ex1
  const edges = solidToEdges(occ, table, body.shape!, {
    createdBy: 'ex1',
    bodyId: 'body_ex1',
    edgeUuids: body.edge_uuids,
    edgeAncestry: body.edge_ancestry,
    profileQueries: body.profile_queries,
  })
  const index = edges.edges.findIndex((edge) =>
    edge.kind === 'line'
    && Math.abs(edge.start[2] - 5) < 1e-6
    && Math.abs(edge.start[1] - 10) < 1e-6
    && Math.abs(edge.end[1] - 10) < 1e-6)
  if (index < 0) throw new Error('no top straight edge on the plate')
  return edges.edge_queries[index]
}

describe.skipIf(!oc)('fillet/chamfer tangent chain is a solver_note (real OCC)', () => {
  it('a fillet on one loop edge reports the chain as a note, not a warning', () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = plate(oc, scope, table)
      const result = solveFillet(
        oc, scope, table,
        { id: 'fi1', fillet: { edges: [topEdgeQuery(oc, table, bodyStore)], radius: 0.5 } },
        new Repository(), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toBeUndefined()
      expect(result.solver_note).toBe(
        'fillet: the picked edges continue along the tangent chain, so 8 edges were filleted (7 of them not picked)',
      )
    } finally {
      scope.dispose()
    }
  })

  it('a chamfer writes the same note with its own wording', () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = plate(oc, scope, table)
      const result = solveChamfer(
        oc, scope, table,
        { id: 'ch1', chamfer: { edges: [topEdgeQuery(oc, table, bodyStore)], distance: 0.5 } },
        new Repository(), bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.solver_warning).toBeUndefined()
      expect(result.solver_note).toBe(
        'chamfer: the picked edges continue along the tangent chain, so 8 edges were chamfered (7 of them not picked)',
      )
    } finally {
      scope.dispose()
    }
  })
})
