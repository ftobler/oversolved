// @vitest-environment node
//
// Real-OCC guard for face silhouette projection (full-brep-projection): every
// face of a box resolves to its 4 boundary edge queries, each of which is a
// real edge query the body also exposes, and box topology holds (12 edges, each
// shared by exactly 2 faces). Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { HandleTable } from './handleTable'
import { buildBox } from './shapes'
import { makeBox } from './primitives'
import { applyFilletWithLineage } from './edgeModifier'
import { solidToEdges, solidToFaceEdgeQueries } from './tessellation'
import type { OccShape } from './occTypes'

const oc = await loadOcc()

/** The first edge OCC yields from a shape (used only as a fillet target). */
function firstEdge(occ: NonNullable<typeof oc>, scope: DisposeScope, shape: OccShape): OccShape {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  return scope.track(occ.TopoDS.Edge_1(exp.Current()))
}

describe.skipIf(!oc)('solidToFaceEdgeQueries (real OCC)', () => {
  it('maps each box face to its boundary edge queries', () => {
    const table = new HandleTable()
    const handle = buildBox(oc!, table, { dx: 10, dy: 6, dz: 4 })
    const opts = { createdBy: 'box1', bodyId: '@body_1' }

    const { edge_queries } = solidToEdges(oc!, table, handle, opts)
    const faceEdgeQueries = solidToFaceEdgeQueries(oc!, table, handle, edge_queries)

    // A box has 6 faces, 12 edges; each face is bounded by 4 edges.
    expect(faceEdgeQueries).toHaveLength(6)
    for (const fe of faceEdgeQueries) {
      expect(fe).toHaveLength(4)
      for (const q of fe) {
        expect(edge_queries).toContain(q)  // a real, pickable edge query
        expect(q.length).toBeGreaterThan(0)
      }
    }

    // Every edge appears on exactly two faces (closed box manifold).
    const counts = new Map<string, number>()
    for (const fe of faceEdgeQueries) for (const q of fe) counts.set(q, (counts.get(q) ?? 0) + 1)
    expect(counts.size).toBe(12)
    for (const c of counts.values()) expect(c).toBe(2)
  })

  // Curved edges that meet at shared vertices are the case where identity
  // dedup (HashCode + IsSame) matters most: the fillet fan introduces circular
  // edges each owned by two faces. Filleting one box edge rounds it into a
  // cylindrical face bordered by curved edges; the whole solid stays a closed
  // 2-manifold, so every boundary edge query must still land on exactly 2 faces.
  it('maps each filleted-box face to its boundary edge queries', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(oc!, scope, 10, 6, 4)
      const res = applyFilletWithLineage(oc!, scope, box, 1.0, [firstEdge(oc!, scope, box)])
      expect(res.success).toBe(true)

      const handle = table.register(res.shape)
      const { edge_queries } = solidToEdges(oc!, table, handle, { createdBy: 'fillet1', bodyId: '@body_1' })
      const faceEdgeQueries = solidToFaceEdgeQueries(oc!, table, handle, edge_queries)

      // A fillet turns one of the box's 6 faces into a rounded transition, so
      // the solid gains a face and edges; every returned query is a real,
      // pickable edge.
      expect(faceEdgeQueries.length).toBeGreaterThan(6)
      expect(edge_queries.length).toBeGreaterThan(12)
      for (const fe of faceEdgeQueries) {
        expect(fe.length).toBeGreaterThanOrEqual(3)
        for (const q of fe) expect(edge_queries).toContain(q)
      }

      // Closed-manifold invariant at the identity level: each unique edge borders
      // exactly two faces, so the total (face, boundary-edge) incidence count must
      // be 2 x the number of unique edges. Under-counting would mean the identity
      // lookup returned -1; over-counting would mean per-face dedup let a shared
      // edge through twice. (We count incidences, not distinct query strings, since
      // geom-hash naming can collapse two edges onto one query.)
      let incidences = 0
      for (const fe of faceEdgeQueries) incidences += fe.length
      expect(incidences).toBe(2 * edge_queries.length)
    } finally {
      scope.dispose()
    }
  })
})
