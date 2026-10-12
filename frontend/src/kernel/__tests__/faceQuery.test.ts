import { describe, it, expect } from "vitest"
import fixture from "../occ/__fixtures__/faceQueries.json"
import { buildFaceQuery } from "../faceQuery"
import { constructionUuidToken, makeAncestryQuery, parseAncestry, Repository } from "../query"
import { registerBodyBrepFromMeta } from "../builder"
import type { Body } from "../types3d"

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
    // A face-specific ancestor token still mints the legacy uuid-less query
    // (a bare createdBy+bodyId net falls to the last resort below).
    const q = buildFaceQuery("f1", "body_0", 0, "plane", null, ["@f1/e0"], null, null)
    expect(q).not.toBeNull()
    const [ids] = parseAncestry(q as string)
    expect(ids.some((i) => i.startsWith("@u|"))).toBe(false)
  })
})

// The last resort: without a uuid, face ancestry or classifiers, the rest of the
// net (createdBy+bodyId+body-wide profile queries) is byte-identical for every
// such sibling and the resolver throws AmbiguousQueryError on the pick. The face
// still gets a query, separated from its siblings by the registrar's per-index
// ancestor tag, and that query resolves to the element the registrar wrote.
describe("buildFaceQuery last resort (no uuid, body-wide ancestry)", () => {
  const shared: [string, string, number, string] = ["f1", "body_0", 0, "flatface"]
  const bodyWide = ["?7;@f1"]

  it("mints a distinct query for each face that has nothing else to tell it apart", () => {
    const faceA = buildFaceQuery(...shared, bodyWide, null, null, null)
    const faceB = buildFaceQuery("f1", "body_0", 1, "flatface", bodyWide, null, null, null)
    expect(faceA).toBe(makeAncestryQuery(["@f1", "@body_0", "@body_0/face0", "?7;@f1"], "flatface"))
    expect(faceB).toBe(makeAncestryQuery(["@f1", "@body_0", "@body_0/face1", "?7;@f1"], "flatface"))
  })

  it("a bare createdBy+bodyId net gets the index tag too", () => {
    expect(buildFaceQuery("f1", "body_0", 0, "flatface"))
      .toBe(makeAncestryQuery(["@f1", "@body_0", "@body_0/face0"], "flatface"))
  })

  it("resolves to the element the registrar wrote for that face", () => {
    const repo = new Repository()
    const body = {
      id: "body_0", created_by: "f1", modified_by: [], shape: null, sketch_id: "sk1",
      brep_diff: null, profile_queries: bodyWide,
    } as unknown as Body
    const faceData = [0, 1].map((i) => ({ centroid: [i, 0, 0], normal: [0, 0, 1], surface_type: "flatface", classifiers: [] }))
    registerBodyBrepFromMeta(repo, body, {
      mesh: { vertices: [], faces: [], triangle_to_face: [], face_queries: [], face_data: faceData, face_uuids: [null, null], is_fallback: false },
    })
    for (const i of [0, 1]) {
      const q = buildFaceQuery("f1", "body_0", i, "flatface", bodyWide, null, null, null)!
      expect((repo.query(q, null, { body_0: body }) as { face_index?: number }).face_index).toBe(i)
    }
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
    // Non-null alone would still pass if the tokens were only counted by the
    // collision guard and then dropped from the emitted ids; the face-specific
    // token has to actually reach the wire to separate the siblings.
    expect(parseAncestry(q as string)[0]).toContain("@f1/e0")
  })
})
