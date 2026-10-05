// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  isGeomHashId,
  makeAncestryQuery,
  ancestry,
  constructionUuidToken,
  Repository,
  AmbiguousQueryError,
} from "./query"
import { type Payload, makeFacePayload } from "./queryTestUtils"

describe("UUID fallback (two-tier ancestry resolution)", () => {
  it("isGeomHashId detects prefixes", () => {
    expect(isGeomHashId("@gface_abc123")).toBe(true)
    expect(isGeomHashId("@gedge_abc123")).toBe(true)
    expect(isGeomHashId("@gvertex_abc123")).toBe(true)
    expect(isGeomHashId("@ex1")).toBe(false)
    expect(isGeomHashId("@body_ex1")).toBe(false)
    expect(isGeomHashId("@body_ex1/face0")).toBe(false)
  })

  // Hash in byUuid does not affect pure-ancestry queries.
  it("uuid in byUuid does not affect pure-ancestry queries", () => {
    const repo = new Repository()
    const payload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "gface_abc")

    const result = repo.query(makeAncestryQuery(["@ex1"]))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["created_by"]).toBe("ex1")
  })

  // After registering with uuid, no frozenset in ancestral contains a geom_hash string.
  it("no geom_hash tag in any ancestral key Set", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/face0", "@ex1", "@body1"],
      makeFacePayload("body1", "ex1", 0),
      "gface_abc",
    )
    repo.registerAncestor(
      ["@body1/edge0", "@ex1", "@body1"],
      { type: "edge", body_id: "body1", created_by: "ex1" },
      "gedge_xyz",
    )

    for (const entry of repo.ancestral.values()) {
      for (const tag of entry.set) {
        expect(isGeomHashId(tag)).toBe(false)
      }
    }
  })

  // registerAncestor with uuid populates byUuid.
  it("registerAncestor with uuid populates byUuid", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/face0", "@ex1", "@body1"],
      makeFacePayload("body1", "ex1", 0),
      "gface_abc",
    )

    expect(repo.byUuid.has("gface_abc")).toBe(true)
    expect(repo.byUuid.get("gface_abc")!.length).toBe(1)
  })

  // When ancestral query finds nothing, byUuid is consulted as last resort.
  it("UUID fallback when ancestral query finds nothing", () => {
    const repo = new Repository()
    const payload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "u_hash1")

    const result = repo.query(makeAncestryQuery([constructionUuidToken("u_hash1")]))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["created_by"]).toBe("ex1")
  })

  // UUID fallback respects type_restriction.
  it("UUID fallback respects type restriction", () => {
    const repo = new Repository()
    const facePayload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], facePayload, "u_hash1")

    const result = repo.query(makeAncestryQuery([constructionUuidToken("u_hash1")], "flatface"))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["type"]).toBe("flatface")

    const wrongType = repo.query(makeAncestryQuery([constructionUuidToken("u_hash1")], "edge"))
    expect(wrongType).toBeNull()
  })

  // Two faces share structural ancestry but differ by UUID; UUID narrows the result.
  it("UUID disambiguates when shared structural ancestry is ambiguous", () => {
    const repo = new Repository()
    const payloadA = makeFacePayload("body1", "ex1", 0)
    const payloadB = makeFacePayload("body1", "ex1", 1)

    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payloadA, "u_aaa")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], payloadB, "u_bbb")

    expect(() => repo.query(makeAncestryQuery(["@ex1"]))).toThrow(AmbiguousQueryError)

    const resultA = repo.query(makeAncestryQuery([constructionUuidToken("u_aaa"), "@ex1", "@body1"]))
    expect(resultA).not.toBeNull()
    expect((resultA as Payload)["face_index"]).toBe(0)

    const resultB = repo.query(makeAncestryQuery([constructionUuidToken("u_bbb"), "@ex1", "@body1"]))
    expect(resultB).not.toBeNull()
    expect((resultB as Payload)["face_index"]).toBe(1)
  })

  // Edge uuids populate byUuid, not ancestral keys.
  it("edge uuid populates byUuid not ancestral", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/edge0", "@ex1", "@body1"],
      { type: "straightedge", body_id: "body1", created_by: "ex1", edge_index: 0 },
      "gedge_xyz",
    )

    expect(repo.byUuid.has("gedge_xyz")).toBe(true)
    expect(repo.byUuid.get("gedge_xyz")!.length).toBe(1)

    for (const entry of repo.ancestral.values()) {
      for (const tag of entry.set) {
        expect(isGeomHashId(tag)).toBe(false)
      }
    }
  })

  // Vertex uuids populate byUuid, not ancestral keys.
  it("vertex uuid populates byUuid not ancestral", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/vertex0", "@ex1", "@body1"],
      { type: "vertex", body_id: "body1", created_by: "ex1", vertex_index: 0 },
      "gvertex_def",
    )

    expect(repo.byUuid.has("gvertex_def")).toBe(true)
    expect(repo.byUuid.get("gvertex_def")!.length).toBe(1)

    for (const entry of repo.ancestral.values()) {
      for (const tag of entry.set) {
        expect(isGeomHashId(tag)).toBe(false)
      }
    }
  })
})

/** Fail-loud semantics of the construction-UUID tier (uuid-tier-type-fallthrough).
 *
 * A query that names a live construction UUID must resolve to the element that
 * carries the uuid, or fail loud. It must never silently fall through to the
 * ancestral tiers and resolve a DIFFERENT element that does not carry the uuid:
 * the old type-filter-excludes path masked that swap behind _lastTier
 * "ancestral". The uuid-alone null case is genuinely different - no right-type
 * sibling exists under the same ancestors, so the weaker tiers resolve nothing
 * and the query stays a miss. */

describe("uuid tier fail-loud semantics", () => {
  it("uuid + wrong type + a right-type sibling under the same ancestors throws instead of resolving the sibling", () => {
    const repo = new Repository()
    // The uuid element is a flatface; a straightedge sibling shares its
    // ancestors and carries no uuid.
    repo.registerAncestor(["@A", "@B"], makeFacePayload("body1", "ex1", 0), "u_face")
    repo.registerAncestor(
      ["@A", "@B"],
      { type: "straightedge", body_id: "body1", created_by: "ex1", edge_index: 0 },
    )
    // Old behavior silently resolved the edge sibling via the ancestral tier,
    // tagging the query _lastTier "ancestral" -- a masked swap of the uuid element.
    const q = makeAncestryQuery([constructionUuidToken("u_face"), "@A", "@B"], "edge")
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("uuid + wrong type without a right-type sibling under the ancestors stays a null miss (uuid-alone)", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B"], makeFacePayload("body1", "ex1", 0), "u_face")
    const q = makeAncestryQuery([constructionUuidToken("u_face"), "@A", "@B"], "edge")
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("a 2-hit uuid bucket is a collision even when one hit fails the type filter", () => {
    const repo = new Repository()
    // Same construction uuid minted onto two elements; a face restriction would
    // silently narrow the edge away under the old filter-then-collide ordering.
    repo.registerAncestor(["@A"], makeFacePayload("body1", "ex1", 0), "u_dup")
    repo.registerAncestor(
      ["@A"],
      { type: "straightedge", body_id: "body1", created_by: "ex1", edge_index: 0 },
      "u_dup",
    )
    const q = makeAncestryQuery([constructionUuidToken("u_dup")], "face")
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("a query naming two distinct construction uuids fails loud instead of picking one", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A"], makeFacePayload("body1", "ex1", 0), "u_one")
    repo.registerAncestor(["@B"], makeFacePayload("body1", "ex1", 1), "u_two")
    const q = makeAncestryQuery([constructionUuidToken("u_two"), constructionUuidToken("u_one")])
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("repeated tokens of the same uuid are not distinct: the query still resolves", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A"], makeFacePayload("body1", "ex1", 0), "u_x")
    const q = makeAncestryQuery([constructionUuidToken("u_x"), constructionUuidToken("u_x")])
    expect(repo.query(q)).not.toBeNull()
    expect(repo._lastTier).toBe("uuid")
  })

  it("a uuid-resolved query reports the uuid tier even when a right-type sibling shares the ancestors", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B"], makeFacePayload("body1", "ex1", 0), "u_face")
    repo.registerAncestor(
      ["@A", "@B"],
      { type: "straightedge", body_id: "body1", created_by: "ex1", edge_index: 0 },
    )
    const q = makeAncestryQuery([constructionUuidToken("u_face"), "@A", "@B"], "face")
    expect(repo.query(q)).not.toBeNull()
    expect(repo._lastTier).toBe("uuid")
  })
})

/**
 * Face registrations have >=3 structural tags (positional /face tag, feature ref, body ref).
 * The geom hash lives in by_geom_hash, not in the ancestral key itself.
 */

describe("ordering guard: order-hidden uuid fallthrough (the deliberate exception)", () => {
  // Same shape as the ordering-guard reg helper but with a tag, so the
  // assertions can name which sibling resolved.
  function reg(
    repo: Repository,
    ancestors: string[],
    owner: string,
    tag: string,
    uuid?: string,
    type = "face",
  ): string {
    return repo.registerAncestor(
      ancestors,
      { type, tag, created_by: owner },
      uuid ?? null,
    )
  }

  it("hidden uuid plus earlier-owned sibling resolves the sibling via the ancestral tier", () => {
    // Pins the deliberate fallthrough documented in query.ts: when the live
    // uuid element is order-hidden, the uuid tier 'continue's into the weaker
    // tiers instead of failing loud like refuseUuidSwap does for type
    // exclusion. That is safe because every weaker tier applies the same
    // orderFilter, so the hidden sk2 element can never be the answer.
    const repo = new Repository()
    repo.setFeatureOrder(["sk1", "sk2"])
    reg(repo, ["@sk1"], "sk1", "a")
    reg(repo, ["@sk1"], "sk2", "b", "u_X")
    const q = ancestry([constructionUuidToken("u_X"), "@sk1"])

    const resolved = repo.query(q, null, null, "sk1") as Record<string, unknown>
    expect(resolved).not.toBeNull()
    expect(resolved.tag).toBe("a")
    expect(resolved.created_by).toBe("sk1")
    expect(repo._lastTier).toBe("ancestral")
  })

  it("uuid whose only live element is order-hidden resolves nothing", () => {
    // A uuid naming only a forward element must resolve nothing rather than
    // leak geometry the current feature may not see yet. Contrast the
    // type-excluded case, which fails loud via refuseUuidSwap: here the
    // weaker tiers legitimately own the miss, so null is the contract.
    const repo = new Repository()
    repo.setFeatureOrder(["sk1", "sk2"])
    reg(repo, ["@sk1"], "sk1", "a")
    reg(repo, ["@sk1"], "sk2", "b", "u_X")
    const q = ancestry([constructionUuidToken("u_X")])

    expect(repo.query(q, null, null, "sk1")).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("without a current feature the same uuid-only query resolves the element", () => {
    // The hidden-ness comes only from the guard context, not from
    // registration: with no current feature the filter is identity and the
    // uuid tier answers directly.
    const repo = new Repository()
    repo.setFeatureOrder(["sk1", "sk2"])
    reg(repo, ["@sk1"], "sk1", "a")
    reg(repo, ["@sk1"], "sk2", "b", "u_X")
    const q = ancestry([constructionUuidToken("u_X")])

    const resolved = repo.query(q) as Record<string, unknown>
    expect(resolved.tag).toBe("b")
    expect(repo._lastTier).toBe("uuid")
  })
})

/** Ordering guard applied inside the coerceType sibling scan: a query that
 *  coerces to an edge/face must never reach a sibling owned by a feature
 *  ordered after the current one. The ancestry tiers order-filter their
 *  candidates before the type restriction, but the coerce scan walks the
 *  lineage independently and used to bypass the guard entirely. */
