import { describe, it, expect } from "vitest"
import { decorateTopology } from "./topologyDecorate"

// A unit square traced CCW out of four line edges, centroid at (cx, cy).
// `divId` labels the bottom edge so two stacked squares can share the same
// dividing line id, which is what drives the line-division classifier.
function squareBoundary(
  x0: number,
  y0: number,
  w: number,
  h: number,
  divId: string,
  divIdx: number,
  prefix: string,
): Record<string, unknown>[] {
  const corners = [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ]
  return corners.map((c, i) => {
    const next = corners[(i + 1) % corners.length]
    return {
      kind: "line",
      id: i === divIdx ? divId : `${prefix}_${i}`,
      start: c,
      end: next,
    }
  })
}

describe("decorateTopology", () => {
  /** Edges gain an ancestry query, drop the `edge_type` hint, and keep geometry. */
  it("decorates edges and strips the edge_type hint", () => {
    const structural = {
      intersection_points: {},
      vertices: {},
      edges: [
        { edge_type: "straightedge", entity_id: "e1", edge_index: 0, length: 5 },
        { edge_type: "edge", entity_id: "e2", edge_index: 1, length: 7 },
      ],
      surfaces: [],
    }
    const out = decorateTopology(structural, "F1")
    expect(out.edges).toHaveLength(2)
    for (const e of out.edges) {
      expect(typeof e.query).toBe("string")
      expect(e.query as string).not.toBe("")
      expect(e).not.toHaveProperty("edge_type")  // decoration hint is stripped
    }
    expect(out.edges[0].length).toBe(5)  // non-hint fields pass through
    expect(out.edges[1].length).toBe(7)
  })

  /** Surfaces gain a `flatface` query and drop the `face_entity_ids` hint. */
  it("decorates surfaces and strips the face_entity_ids hint", () => {
    const structural = {
      intersection_points: {},
      vertices: {},
      edges: [],
      surfaces: [
        { face_entity_ids: ["a"], boundary: [], normal: [0, 0, 1] },
      ],
    }
    const out = decorateTopology(structural, "F1")
    expect(out.surfaces).toHaveLength(1)
    const s = out.surfaces[0]
    expect(typeof s.query).toBe("string")
    expect(s).not.toHaveProperty("face_entity_ids")  // hint is stripped
    expect(s.normal).toEqual([0, 0, 1])  // other fields pass through
  })

  /** intersection_points and vertices are carried over verbatim. */
  it("passes through intersection_points and vertices", () => {
    const structural = {
      intersection_points: { i0: { x: 1, y: 2 } },
      vertices: { v0: { x: 3, y: 4 } },
      edges: [],
      surfaces: [],
    }
    const out = decorateTopology(structural, "F1")
    expect(out.intersection_points).toEqual({ i0: { x: 1, y: 2 } })
    expect(out.vertices).toEqual({ v0: { x: 3, y: 4 } })
  })

  /** Two surfaces that share a source entity (same face_entity_ids) form a
   *  line-division group: each gains side classifiers, with opposite signs on
   *  the shared dividing edge. A surface alone in its group gets none. */
  it("attaches opposite-side classifiers to a shared dividing line", () => {
    const structural = {
      intersection_points: {},
      vertices: {},
      edges: [],
      surfaces: [
        // upper square: its bottom edge (idx 0) is the y=0 dividing line "L"
        { face_entity_ids: ["L"], boundary: squareBoundary(0, 0, 4, 2, "L", 0, "up") },
        // lower square: its top edge (idx 2) is the same y=0 dividing line "L"
        { face_entity_ids: ["L"], boundary: squareBoundary(0, -2, 4, 2, "L", 2, "lo") },
        // lone surface, different source entity, no group partner
        { face_entity_ids: ["Z"], boundary: squareBoundary(10, 0, 1, 1, "Z", 0, "alone") },
      ],
    }
    const out = decorateTopology(structural, "F1")
    const upper = out.surfaces[0].classifiers as string[]
    const lower = out.surfaces[1].classifiers as string[]
    const alone = out.surfaces[2]

    expect(upper).toContain("cls_ld_L_p")
    expect(lower).toContain("cls_ld_L_n")
    // the dividing line resolves to opposite sides for the two surfaces
    expect(upper).not.toContain("cls_ld_L_n")
    expect(lower).not.toContain("cls_ld_L_p")
    // a surface with no group partner gets no classifiers
    expect(alone).not.toHaveProperty("classifiers")

    // the attached tokens are folded back into the surface query
    for (const tok of upper) expect(out.surfaces[0].query as string).toContain(tok)
  })
})
