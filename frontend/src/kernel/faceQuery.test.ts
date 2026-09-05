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
    const q = buildFaceQuery("f1", "body_0", 0, "plane", null, null, null, uuid)
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids[0]).toBe(constructionUuidToken(uuid))
    // Stage 6: no descriptor or geom-hash token rides alongside the UUID.
    expect(ids.some((i) => i.startsWith("@gdf|"))).toBe(false)
    expect(ids.some((i) => i.startsWith("@gface_"))).toBe(false)
  })
  it("omits @u| when no uuid is given (unchanged legacy shape)", () => {
    // A bare createdBy+bodyId net without a uuid is the M5 collision shape and
    // now returns null; a face-specific ancestor token still mints the legacy
    // uuid-less query.
    const q = buildFaceQuery("f1", "body_0", 0, "plane", null, ["@f1/e0"], null, null)
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids.some((i) => i.startsWith("@u|"))).toBe(false)
  })
})

// M5 collision guard: the bodyId branch ignores `faceIdx`, so without a uuid the
// query carries no per-face identity token. Two faces sharing the body-wide
// ancestry (profile queries) and no classifiers would otherwise mint ONE
// byte-identical query, and the resolver throws AmbiguousQueryError on the pick.
// The guard returns null so the caller falls back to the index-keyed
// topoFallbackQuery, which keeps the face selectable.
describe("buildFaceQuery collision guard (no uuid, body-wide ancestry)", () => {
  const shared: [string, string, number, string] = ["f1", "body_0", 0, "flatface"]
  const bodyWide = ["?7;@f1"]

  it("returns null for every face that cannot be told apart from its siblings", () => {
    // Two faces of one body, both uuid-less, both carrying only the body-wide
    // profile ancestry and no classifiers: they are byte-identical today, so
    // the guard refuses to mint the colliding query for EITHER of them.
    const faceA = buildFaceQuery(...shared, bodyWide, null, null, null)
    const faceB = buildFaceQuery("f1", "body_0", 1, "flatface", bodyWide, null, null, null)
    expect(faceA).toBeNull()
    expect(faceB).toBeNull()
  })

  it("a bare createdBy+bodyId net is the same refusal", () => {
    const q = buildFaceQuery("f1", "body_0", 0, "flatface")
    expect(q).toBeNull()
  })

  it("a uuid restores the emitted query for the same face", () => {
    const q = buildFaceQuery("f1", "body_0", 0, "flatface", bodyWide, null, null, "u_face")
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids[0]).toBe(constructionUuidToken("u_face"))
  })

  it("face-specific ancestry tokens still mint a query without a uuid", () => {
    // Ancestor tokens are per-face (they come from the face's own ancestry),
    // so they can separate siblings even when the uuid is absent.
    const q = buildFaceQuery("f1", "body_0", 0, "flatface", null, ["@f1/e0"], null, null)
    expect(q).not.toBeNull()
  })
})
