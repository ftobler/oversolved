// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  makeAncestryQuery,
  ancestry,
  constructionUuidToken,
  Repository,
} from "./query"

describe("queryAll", () => {
  it("returns empty for non-ancestry query", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1face0", "@feat1"], { type: "flatface" })
    expect(repo.queryAll("@feat1")).toEqual([])
    expect(repo.queryAll("")).toEqual([])
  })

  it("finds by feature root", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1face0", "@feat1"], { type: "flatface", idx: 0 })
    repo.registerAncestor(["@feat1face1", "@feat1"], { type: "flatface", idx: 1 })
    repo.registerAncestor(["@feat2face0", "@feat2"], { type: "flatface", idx: 99 })

    const results = repo.queryAll(makeAncestryQuery(["@feat1"], "flatface"))
    expect(results.length).toBe(2)
    for (const r of results) {
      expect((r as Record<string, unknown>).type).toBe("flatface")
    }
    expect(new Set(results.map(r => (r as Record<string, unknown>).idx))).toEqual(new Set([0, 1]))
  })

  it("type filters correctly", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1face0", "@feat1"], { type: "flatface" })
    repo.registerAncestor(["@feat1edge0", "@feat1"], { type: "straightedge" })

    expect(repo.queryAll(makeAncestryQuery(["@feat1"], "flatface")).length).toBe(1)
    expect(repo.queryAll(makeAncestryQuery(["@feat1"], "straightedge")).length).toBe(1)
  })

  it("without type restriction returns all", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1face0", "@feat1"], { type: "flatface" })
    repo.registerAncestor(["@feat1edge0", "@feat1"], { type: "straightedge" })
    expect(repo.queryAll(makeAncestryQuery(["@feat1"])).length).toBe(2)
  })

  it("does not bleed across features", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1face0", "@feat1"], { type: "flatface" })
    repo.registerAncestor(["@feat2face0", "@feat2"], { type: "flatface" })

    expect(repo.queryAll(makeAncestryQuery(["@feat1"], "flatface")).length).toBe(1)
    expect(repo.queryAll(makeAncestryQuery(["@feat2"], "flatface")).length).toBe(1)
    expect(repo.queryAll(makeAncestryQuery(["@feat3"], "flatface"))).toEqual([])
  })

  // Existing exact queries must still resolve after the feature root is added.
  it("resolves with extended ancestor set", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1face0", "@feat1"], { type: "flatface", x: 1 })

    const result = repo.query(makeAncestryQuery(["@feat1face0", "@feat1"], "flatface"))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).x).toBe(1)
  })

  it("finds registered solid and face", () => {
    const repo = new Repository()
    repo.registerAncestor(["@ex1"], { type: "solid", created_by: "ex1" })
    repo.registerAncestor(["@ex1face0", "@ex1"], { type: "flatface" })

    const solid = repo.query(makeAncestryQuery(["@ex1"], "solid"))
    expect(solid).not.toBeNull()
    expect((solid as Record<string, unknown>).type).toBe("solid")

    const face = repo.query(makeAncestryQuery(["@ex1face0", "@ex1"], "flatface"))
    expect(face).not.toBeNull()
  })

  // ─── special-token alignment (queryall-special-token-trap) ───

  it("uuid-only query returns that uuid's elements only, never the whole repo", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "u_ele" }, "u_aaa")
    repo.registerAncestor(["@feat2"], { type: "straightedge", tag: "other" })
    const results = repo.queryAll(
      makeAncestryQuery([constructionUuidToken("u_aaa")]),
    ) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("u_ele")
  })

  it("classifier-only and geom-hash-only queries return []", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", classifiers: ["cls_zp"] })
    expect(repo.queryAll(makeAncestryQuery(["@cls_zp"]))).toEqual([])
    expect(repo.queryAll(makeAncestryQuery(["@gface_abc"]))).toEqual([])
  })

  it("type restriction matches subtypes (face finds flatfaces)", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "ff" })
    const results = repo.queryAll(makeAncestryQuery(["@feat1"], "face")) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("ff")
  })

  it("type-restricted uuid query returns the bucket filtered by subtype", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "f0" }, "u_aaa")
    repo.registerAncestor(["@feat2"], { type: "straightedge", tag: "e0" }, "u_bbb")
    const results = repo.queryAll(
      makeAncestryQuery([constructionUuidToken("u_aaa")], "face"),
    ) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("f0")
  })

  it("narrows by classifier tokens in the framed id list", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "zp", classifiers: ["cls_zp"] })
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "zn", classifiers: ["cls_zn"] })
    const results = repo.queryAll(makeAncestryQuery(["@feat1", "@cls_zp"])) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("zp")
  })

  it("query naming two distinct uuids returns the union of both buckets", () => {
    // The single-result resolver refuses to pick one of two named uuids; queryAll
    // is an enumeration, so the deduped union is the honest multi-result answer.
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "a" }, "u_a")
    repo.registerAncestor(["@feat2"], { type: "straightedge", tag: "b" }, "u_b")
    const results = repo.queryAll(
      makeAncestryQuery([constructionUuidToken("u_a"), constructionUuidToken("u_b")]),
    ) as Record<string, unknown>[]
    expect(new Set(results.map(r => r.tag))).toEqual(new Set(["a", "b"]))
  })

  it("mixed uuid + ancestry query returns the uuid bucket only (uuid tier exclusive)", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "u_ele" }, "u_aaa")
    repo.registerAncestor(["@feat2"], { type: "flatface", tag: "other" })
    const results = repo.queryAll(
      makeAncestryQuery([constructionUuidToken("u_aaa"), "@feat2"]),
    ) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("u_ele")
  })

  it("dead uuid falls through to the ancestral subset tier", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "live" })
    const results = repo.queryAll(
      makeAncestryQuery([constructionUuidToken("u_gone"), "@feat1"]),
    ) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("live")
  })

  it("returns all live elements of a collided uuid bucket instead of throwing", () => {
    // The single-result resolver throws on a construction-uuid collision; queryAll
    // is an enumeration, so the whole bucket is the honest multi-result answer.
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "c0" }, "u_c")
    repo.registerAncestor(["@feat2"], { type: "flatface", tag: "c1" }, "u_c")
    const results = repo.queryAll(makeAncestryQuery([constructionUuidToken("u_c")])) as Record<string, unknown>[]
    expect(new Set(results.map(r => r.tag))).toEqual(new Set(["c0", "c1"]))
  })

  it("uuid query whose element is type-excluded returns [] (no weaker-tier fallback)", () => {
    // Align with refuseUuidSwap: a live uuid element the type restriction
    // excludes must not silently enumerate a different element in its place.
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "straightedge", tag: "e0" }, "u_aaa")
    expect(repo.queryAll(makeAncestryQuery([constructionUuidToken("u_aaa")], "face"))).toEqual([])
  })

  it("mixed query with a type-excluded live uuid returns [] (uuid identity stays authoritative)", () => {
    // The uuid names a live element of the wrong type, so the query has no
    // answer even though @feat2 owns right-type siblings: enumeration must not
    // silently swap in elements that do not carry the uuid. The resolver throws
    // here (refuseUuidSwap); queryAll softens that to an empty enumeration.
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "straightedge", tag: "e0" }, "u_aaa")
    repo.registerAncestor(["@feat2"], { type: "flatface", tag: "other" })
    expect(
      repo.queryAll(makeAncestryQuery([constructionUuidToken("u_aaa"), "@feat2"], "face")),
    ).toEqual([])
  })

  it("classifier veto returns [] instead of a whole-set enumeration", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "a", classifiers: ["cls_zn"] })
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "b", classifiers: ["cls_zn"] })
    expect(repo.queryAll(makeAncestryQuery(["@feat1", "@cls_zp"]))).toEqual([])
  })

  it("queryAll / queryAllTyped write _lastTier honestly on every return path", () => {
    // _lastTier is the "did this silently downgrade a tier" signal. queryAll used
    // to leave it stale from a previous query; an interleaved enumeration then
    // reported a tier it did not resolve. Every path must label itself.
    const repo = new Repository()
    repo.registerAncestor(
      ["@feat1"],
      { type: "flatface", tag: "zp", classifiers: ["cls_zp"] },
      "u_aaa",
    )
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "zn", classifiers: ["cls_zn"] })

    // uuid bucket return.
    repo.queryAll(makeAncestryQuery([constructionUuidToken("u_aaa")]))
    expect(repo._lastTier).toBe("uuid")

    // special-only guard: classifier-only query enumerates nothing.
    repo.queryAll(makeAncestryQuery(["@cls_zp"]))
    expect(repo._lastTier).toBe("miss")

    // classifier veto: both candidates carry non-empty evidence lacking the
    // wanted token, so the set narrows to [].
    repo.queryAll(makeAncestryQuery(["@feat1", "@cls_zz"]))
    expect(repo._lastTier).toBe("miss")

    // final ancestral enumeration.
    repo.queryAll(makeAncestryQuery(["@feat1"], "face"))
    expect(repo._lastTier).toBe("ancestral")

    // queryAllTyped routes through the same resolver and labels itself too.
    repo.queryAllTyped(ancestry([constructionUuidToken("u_aaa")]))
    expect(repo._lastTier).toBe("uuid")
    repo.queryAllTyped(ancestry(["@feat1"], "face"))
    expect(repo._lastTier).toBe("ancestral")
    repo.queryAllTyped(ancestry(["@cls_zp"]))
    expect(repo._lastTier).toBe("miss")
  })

  it("uuid tier resolves ignoring classifiers", () => {
    // Same alignment as the resolver's "UUID resolves even with contradictory
    // classifiers": the uuid bucket answers first and the classifier tokens never
    // narrow it.
    const repo = new Repository()
    repo.registerAncestor(
      ["@feat1"],
      { type: "flatface", tag: "u_ele", classifiers: ["cls_zn"] },
      "u_aaa",
    )
    repo.registerAncestor(["@feat2"], { type: "flatface", tag: "zp", classifiers: ["cls_zp"] })
    const results = repo.queryAll(
      makeAncestryQuery([constructionUuidToken("u_aaa"), "@cls_zp"]),
    ) as Record<string, unknown>[]
    expect(results.map(r => r.tag)).toEqual(["u_ele"])
  })

  it("a single order-hidden uuid hit falls through to the ancestral subset tier", () => {
    // The resolver deliberately "continue"s on an ordering-guard exclusion
    // (query.ts: orderFilter is empty => continue), so queryAll must not treat a
    // single hidden uuid hit as an empty bucket: it falls through and the weaker
    // tiers filter the same owner, keeping the hidden element out.
    const repo = new Repository()
    repo.setFeatureOrder(["sk1", "sk2"])
    repo.registerAncestor(["@sk1"], { type: "flatface", tag: "a", created_by: "sk1" })
    repo.registerAncestor(["@sk1"], { type: "flatface", tag: "b", created_by: "sk2" }, "u_X")
    const results = repo.queryAll(
      makeAncestryQuery([constructionUuidToken("u_X"), "@sk1"]),
      "sk1",
    ) as Record<string, unknown>[]
    expect(results.map(r => r.tag)).toEqual(["a"])
  })

  it("descriptor-only query returns []", () => {
    // A legacy @gd*| token carries no ancestral ids, so the nonHashIds guard
    // fires exactly like the classifier/hash-only cases.
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "ff" })
    expect(repo.queryAll(makeAncestryQuery(["@gdf|0,0,0|0,0,1"]))).toEqual([])
  })

  it("fails loud on upward :solid coercion with no body store", () => {
    // coerceType's failLoud throws in test mode, so a null or empty store is a
    // wiring bug the enumeration must surface, not silently degrade to [] (the
    // pre-alignment queryAll never coerced and returned [] here).
    const repo = new Repository()
    repo.registerAncestor(
      ["@feat1"],
      { type: "flatface", body_id: "body_ex1", created_by: "ex1" },
    )
    expect(() => repo.queryAll(makeAncestryQuery(["@feat1"], "solid"))).toThrow()
    expect(() => repo.queryAll(makeAncestryQuery(["@feat1"], "solid"), null, {})).toThrow()
  })

  it("coerces candidates upward to a solid via the body store", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@feat1"],
      { type: "flatface", body_id: "body_ex1", created_by: "ex1" },
    )
    const results = repo.queryAll(makeAncestryQuery(["@feat1"], "solid"), null, bodyStore)
    expect(results).toEqual([bodyStore["body_ex1"]])
  })

  it("coerces candidates downward to a same-lineage sibling", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { type: "solid", body_id: "body_ex1", created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_ex1", created_by: "ex1" },
    )
    const results = repo.queryAll(
      makeAncestryQuery(["@ex1"], "edge"),
      null,
      bodyStore,
    ) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].type).toBe("straightedge")
  })
})

