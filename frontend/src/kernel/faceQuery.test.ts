import { describe, it, expect } from "vitest"
import fixture from "./occ/__fixtures__/faceQueries.json"
import { buildFaceQuery, faceTokens, edgeLineageTokens } from "./faceQuery"

type BuildArgs = {
  created_by: string | null
  body_id: string | null
  face_idx: number
  centroid: number[]
  normal: number[]
  surface_type: string
  profile_queries: string[] | null
  face_tokens: string[] | null
  classifiers: string[] | null
}

describe("buildFaceQuery parity with Python", () => {
  for (const c of fixture.build) {
    it(c.name, () => {
      const a = c.args as BuildArgs
      const result = buildFaceQuery(
        a.created_by,
        a.body_id,
        a.face_idx,
        a.centroid,
        a.normal,
        a.surface_type,
        a.profile_queries,
        a.face_tokens,
        a.classifiers,
      )
      expect(result).toBe(c.expected)
    })
  }
})

describe("faceTokens / edgeLineageTokens parity", () => {
  const t = fixture.tokens
  it("face_hit", () =>
    expect(faceTokens(t.face_hit.centroid, t.face_hit.normal, t.face_hit.face_lineage)).toEqual(
      t.face_hit.expected,
    ))
  it("face_miss", () =>
    expect(faceTokens(t.face_miss.centroid, t.face_miss.normal, t.face_miss.face_lineage)).toEqual(
      t.face_miss.expected,
    ))
  it("face_null_lineage", () =>
    expect(faceTokens(t.face_null_lineage.centroid, t.face_null_lineage.normal, null)).toEqual(
      t.face_null_lineage.expected,
    ))
  it("edge_hit", () =>
    expect(edgeLineageTokens(t.edge_hit.edge, t.edge_hit.edge_lineage)).toEqual(t.edge_hit.expected))
  it("edge_null_lineage", () =>
    expect(edgeLineageTokens(t.edge_null_lineage.edge, null)).toEqual(t.edge_null_lineage.expected))
  it("edge_hash_raises -> [] (missing arc fields swallowed)", () =>
    expect(edgeLineageTokens(t.edge_hash_raises.edge, t.edge_hash_raises.edge_lineage)).toEqual(
      t.edge_hash_raises.expected,
    ))
})
