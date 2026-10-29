// @vitest-environment node
//
// Real-OCC guard for face silhouette projection (full-brep-projection): every
// face of a box resolves to its 4 boundary edge queries, each of which is a
// real edge query the body also exposes, and box topology holds (12 edges, each
// shared by exactly 2 faces). Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { HandleTable } from '../handleTable'
import { buildBox, buildCylinder } from '../shapes'
import {
  makeBSplineChainEdge,
  makeBox,
  makeCone,
  makeFaceFromWire,
  makeLineEdge,
  makePrism,
  makeWire,
} from '../primitives'
import { applyFilletWithLineage } from '../edgeModifier'
import { canonicalEdges } from '../bodyNames'
import { solidToEdges, solidToFaceEdgeQueries, sortedUniqueEdges } from '../tessellation'
import type { OccShape } from '../occTypes'

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
    const { face_edge_queries: faceEdgeQueries, face_seam_queries: faceSeamQueries } =
      solidToFaceEdgeQueries(oc!, table, handle, edge_queries)

    // A box has 6 faces, 12 edges; each face is bounded by 4 edges.
    expect(faceEdgeQueries).toHaveLength(6)
    for (const fe of faceEdgeQueries) {
      expect(fe).toHaveLength(4)
      for (const q of fe) {
        expect(edge_queries).toContain(q)  // a real, pickable edge query
        expect(q.length).toBeGreaterThan(0)
      }
    }
    // A closed box has no seam: no face meets an edge twice.
    expect(faceSeamQueries).toHaveLength(6)
    for (const fs of faceSeamQueries) expect(fs).toEqual([])

    // Every edge appears on exactly two faces (closed box manifold).
    const counts = new Map<string, number>()
    for (const fe of faceEdgeQueries) for (const q of fe) counts.set(q, (counts.get(q) ?? 0) + 1)
    expect(counts.size).toBe(12)
    for (const c of counts.values()) expect(c).toBe(2)
  })

  // A full cylinder's lateral face meets its seam edge twice, so the boundary
  // list carries it once while the seam list carries it: the earlier count rule
  // could not tell that from an open shell's free edge.
  it('reports a cylinder lateral seam from the second visit inside its face', () => {
    const table = new HandleTable()
    const handle = buildCylinder(oc!, table, { center: [0, 0, 0], axis: [0, 0, 1], radius: 5, height: 10 })
    const { edge_queries } = solidToEdges(oc!, table, handle, { createdBy: 'cyl1', bodyId: '@body_cyl' })
    const { face_edge_queries, face_seam_queries } = solidToFaceEdgeQueries(oc!, table, handle, edge_queries)

    expect(face_seam_queries).toHaveLength(face_edge_queries.length)
    const seamQueries = face_seam_queries.flat()
    expect(seamQueries).toHaveLength(1)
    expect(edge_queries).toContain(seamQueries[0])
    // The seam is listed once in the boundary list it belongs to.
    const seamFace = face_seam_queries.findIndex(list => list.length > 0)
    expect(face_edge_queries[seamFace]).toContain(seamQueries[0])
    expect(face_edge_queries.flat().filter(q => q === seamQueries[0])).toHaveLength(1)
    // The two rims are ordinary shared edges, listed in no seam list.
    for (const q of face_edge_queries.flat()) {
      if (q !== seamQueries[0]) expect(face_seam_queries.flat()).not.toContain(q)
    }
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
      const { face_edge_queries: faceEdgeQueries } = solidToFaceEdgeQueries(oc!, table, handle, edge_queries)

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

  // A cone apex (and a sphere pole) is a degenerated edge: `readSolidEdges`
  // skips it, and the per-face lookup must use the same list or its indices
  // point at the neighbouring edge's query. The apex sits at the origin so the
  // degenerate sorts first; the old code therefore emptied the cap's boundary
  // list and gave the lateral face the cap's query.
  it('keeps the sorted edge list aligned on a body with a degenerated edge', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const cone = scope.track(makeCone(oc!, scope, [0, 0, 0], [0, 0, 1], 0, 5, 10))
      const handle = table.register(cone, 'cone1')
      const canonical = canonicalEdges(oc!, scope, table.get<OccShape>(handle))
      const degenerated = canonical.filter(edge => oc!.BRep_Tool.Degenerated?.(edge) ?? false)
      // The fixture must really contain one, or this test proves nothing.
      expect(degenerated.length).toBeGreaterThan(0)

      const { edges, edge_queries } = solidToEdges(oc!, table, handle, { createdBy: 'cone1', bodyId: '@body_cone' })
      const sorted = sortedUniqueEdges(oc!, scope, table.get<OccShape>(handle))
      expect(sorted).toHaveLength(edge_queries.length)
      expect(canonical.length).toBe(sorted.length + degenerated.length)

      const lineQuery = edge_queries[edges.findIndex(edge => edge.kind === 'line')]
      const circleQuery = edge_queries[edges.findIndex(edge => edge.kind === 'circle')]
      expect(lineQuery).toBeTruthy()
      expect(circleQuery).toBeTruthy()

      // Pin the content, not just the lengths: the top cap is bounded by the rim
      // alone, the lateral cone face by the rim and its seam.
      const { face_edge_queries, face_seam_queries } = solidToFaceEdgeQueries(oc!, table, handle, edge_queries)
      expect(face_edge_queries).toEqual([[circleQuery], [circleQuery, lineQuery]])
      expect(face_seam_queries).toEqual([[], [lineQuery]])
    } finally {
      scope.dispose()
    }
  })

  it('keeps the sorted edge list aligned on a spline-bearing body', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const spline = scope.track(makeBSplineChainEdge(
        oc!, scope, [[0, 0, 0], [0, 5, 0], [10, 5, 0], [10, 0, 0]], [0, 1],
      ))
      const toTop = scope.track(makeLineEdge(oc!, scope, [10, 0, 0], [10, 10, 0]))
      const close = scope.track(makeLineEdge(oc!, scope, [10, 10, 0], [0, 0, 0]))
      const wire = scope.track(makeWire(oc!, scope, [spline, toTop, close], { requireClosed: true }))
      const face = scope.track(makeFaceFromWire(oc!, scope, wire))
      const solid = scope.track(makePrism(oc!, scope, face, [0, 0, 1], 4))
      const handle = table.register(solid, 'spline1')

      const { edges, edge_queries } = solidToEdges(oc!, table, handle, { createdBy: 'spline1', bodyId: '@body_spline' })
      expect(edges.some(edge => edge.kind === 'spline')).toBe(true)
      expect(sortedUniqueEdges(oc!, scope, table.get<OccShape>(handle))).toHaveLength(edge_queries.length)
    } finally {
      scope.dispose()
    }
  })
})
