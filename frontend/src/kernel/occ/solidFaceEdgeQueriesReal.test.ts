// @vitest-environment node
//
// Real-OCC guard for face silhouette projection (full-brep-projection): every
// face of a box resolves to its 4 boundary edge queries, each of which is a
// real edge query the body also exposes, and box topology holds (12 edges, each
// shared by exactly 2 faces). Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { HandleTable } from './handleTable'
import { buildBox } from './shapes'
import { solidToEdges, solidToFaceEdgeQueries } from './tessellation'

const oc = await loadOcc()

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
})
