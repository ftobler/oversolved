import { describe, it, expect } from "vitest"
import fixture from "./occ/__fixtures__/faceQueries.json"
import { buildFaceQuery, faceTokens, edgeLineageTokens } from "./faceQuery"
import { constructionUuidToken, parseAncestry } from "./query"

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

// Originally a byte-parity gate against the (since removed) Python producer;
// the fixture now pins the persisted wire format itself, so an accidental
// format drift -- which would strand every stored query -- fails here first.
describe("buildFaceQuery wire-format pin", () => {
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

// Stage 4 (query-naming-by-construction): the construction UUID rides the query
// as the first, primary identity token, alongside the descriptor for now.
describe("buildFaceQuery emits the @u| construction token", () => {
  const uuid = "u_deadbeefcafe0001"
  it("prepends @u| as the first id when a uuid is given", () => {
    const q = buildFaceQuery("f1", "body_0", 0, [1, 2, 3], [0, 0, 1], "plane", null, null, null, uuid)
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids[0]).toBe(constructionUuidToken(uuid))
    // Dual-run: the descriptor stays alongside the UUID until Stage 6.
    expect(ids.some((i) => i.startsWith("@gdf|"))).toBe(true)
  })
  it("omits @u| when no uuid is given (unchanged legacy shape)", () => {
    const q = buildFaceQuery("f1", "body_0", 0, [1, 2, 3], [0, 0, 1], "plane")
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids.some((i) => i.startsWith("@u|"))).toBe(false)
  })
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
  it("edge_miss -> [] (hash absent from a non-null lineage map)", () =>
    expect(
      edgeLineageTokens({ kind: "line", start: [0, 0, 0], end: [1, 0, 0] }, {
        gedge_unrelatedkey: ["@somewhere"],
      }),
    ).toEqual([]))
  it("edge_hash_raises -> [] (missing arc fields swallowed)", () =>
    expect(edgeLineageTokens(t.edge_hash_raises.edge, t.edge_hash_raises.edge_lineage)).toEqual(
      t.edge_hash_raises.expected,
    ))
})
