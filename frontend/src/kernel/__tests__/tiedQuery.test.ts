import { describe, it, expect } from "vitest"
import { emitWithTiesTagged, type QueryParts } from "../tiedQuery"
import { makeAncestryQuery, Repository } from "../query"
import { registerBodyBrepFromMeta } from "../builder"
import type { Body } from "../types3d"

// Two unnamed edges with the same ancestral net and classifiers: the genuine tie
// no symbolic tiebreak separated. Without the tag both emit one query string,
// which resolves to both elements and throws AmbiguousQueryError on the pick.
const tied = (): QueryParts => ({ ids: ["@f1", "@body_0", "@cls_yn"], type: "edge", named: false })

describe("emitWithTiesTagged", () => {
  it("leaves a query with no tie exactly as it was", () => {
    const parts: QueryParts[] = [
      { ids: ["@f1", "@body_0", "@cls_yn"], type: "edge", named: false },
      { ids: ["@f1", "@body_0", "@cls_yp"], type: "edge", named: false },
    ]
    expect(emitWithTiesTagged(parts, "body_0", "edge"))
      .toEqual(parts.map((p) => makeAncestryQuery(p.ids, p.type)))
  })

  it("tags each tied unnamed query with the registrar's index tag", () => {
    expect(emitWithTiesTagged([tied(), tied()], "body_0", "edge")).toEqual([
      makeAncestryQuery(["@f1", "@body_0", "@cls_yn", "@body_0/edge0"], "edge"),
      makeAncestryQuery(["@f1", "@body_0", "@cls_yn", "@body_0/edge1"], "edge"),
    ])
  })

  it("never tags a named element", () => {
    const named: QueryParts = { ids: ["@u|e_1", "@f1", "@body_0"], type: "edge", named: true }
    const out = emitWithTiesTagged([named, { ...named }], "body_0", "edge")
    expect(out).toEqual([makeAncestryQuery(named.ids, "edge"), makeAncestryQuery(named.ids, "edge")])
  })

  it("resolves each tagged edge and vertex to the element the registrar wrote", () => {
    const repo = new Repository()
    const body = {
      id: "body_0", created_by: "f1", modified_by: [], shape: null, sketch_id: "sk1",
      brep_diff: null, profile_queries: [],
    } as unknown as Body
    const edgeQueries = emitWithTiesTagged([tied(), tied()], "body_0", "edge")
    const vertexParts = (): QueryParts => ({ ids: ["@f1", "@body_0"], type: "vertex", named: false })
    const vertexQueries = emitWithTiesTagged([vertexParts(), vertexParts()], "body_0", "vertex")
    const line = (y: number) => ({ kind: "line", start: [0, y, 0], end: [1, y, 0] })
    registerBodyBrepFromMeta(repo, body, {
      mesh: { vertices: [], faces: [], triangle_to_face: [], face_queries: [], face_data: [], is_fallback: false },
      edges: [line(0), line(1)],
      edge_queries: edgeQueries,
      edge_uuids: [null, null],
      vertices: [[0, 0, 0], [1, 0, 0]],
      vertex_queries: vertexQueries,
      vertex_uuids: [null, null],
    })
    for (const i of [0, 1]) {
      expect((repo.query(edgeQueries[i], null, { body_0: body }) as { edge_index?: number }).edge_index).toBe(i)
      expect((repo.query(vertexQueries[i], null, { body_0: body }) as { vertex_index?: number }).vertex_index).toBe(i)
    }
  })
})
