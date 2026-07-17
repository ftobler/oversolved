import { describe, it, expect } from "vitest"
import fixture from "./occ/__fixtures__/faceQueries.json"
import { buildFaceQuery } from "./faceQuery"
import { constructionUuidToken, parseAncestry } from "./query"

type BuildArgs = {
  created_by: string | null
  body_id: string | null
  face_idx: number
  centroid: number[]
  normal: number[]
  surface_type: string
  profile_queries: string[] | null
  ancestor_tokens: string[] | null
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
        a.ancestor_tokens,
        a.classifiers,
      )
      expect(result).toBe(c.expected)
    })
  }
})

// query-naming-by-construction: the construction UUID rides the query as the
// first, primary identity token. Stage 6 removed the face descriptor, so a
// persisted face query now carries only @u| + ancestral tokens + classifiers.
describe("buildFaceQuery emits the @u| construction token", () => {
  const uuid = "u_deadbeefcafe0001"
  it("prepends @u| as the first id when a uuid is given, with no geometry token", () => {
    const q = buildFaceQuery("f1", "body_0", 0, [1, 2, 3], [0, 0, 1], "plane", null, null, null, uuid)
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids[0]).toBe(constructionUuidToken(uuid))
    // Stage 6: no descriptor or geom-hash token rides alongside the UUID.
    expect(ids.some((i) => i.startsWith("@gdf|"))).toBe(false)
    expect(ids.some((i) => i.startsWith("@gface_"))).toBe(false)
  })
  it("omits @u| when no uuid is given (unchanged legacy shape)", () => {
    const q = buildFaceQuery("f1", "body_0", 0, [1, 2, 3], [0, 0, 1], "plane")
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids.some((i) => i.startsWith("@u|"))).toBe(false)
  })
})
