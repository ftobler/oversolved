// Guard, fallback and self-heal paths of the ancestry resolver that the
// corpus/round-trip tests do not reach: the coercion scan's rejection rules,
// the descriptor-only fallback, the legacy descriptor tier, the reverse-index
// rot self-heal, and the non-object element hardening. Each asserts the
// concrete query outcome, not just that a helper returned.

import { describe, it, expect } from "vitest"
import {
  Repository,
  makeAncestryQuery,
  parseAncestry,
  parseConstructionUuidId,
  canonical,
  absolute,
  local,
  constructionUuidToken,
  evictAncestryAndRegister,
  clearBodyAncestry,
  clearConsumedBodyAncestry,
} from "./query"

type Payload = Record<string, unknown>

describe("wire parsing guards", () => {
  it("parseAncestry rejects a string without the ? prefix", () => {
    expect(() => parseAncestry("@feat")).toThrow(/Invalid ancestry query/)
  })

  it("parseConstructionUuidId returns null for a non-uuid token", () => {
    expect(parseConstructionUuidId("@ex1")).toBeNull()
    expect(parseConstructionUuidId(constructionUuidToken("u_1"))).toBe("u_1")
  })

  it("canonical refuses an id containing the NUL key separator", () => {
    // Unescaped, a NUL would silently merge two distinct ancestor sets into one.
    expect(() => canonical(["a\u0000b"])).toThrow(/NUL key separator/)
  })

  it("query returns null for an unrecognized prefix instead of throwing", () => {
    const repo = new Repository()
    expect(repo.query("xbad")).toBeNull()
  })
})

describe("typed absolute lookups", () => {
  it("builds the feature, feature/eid and feature/eid/sub keys", () => {
    const repo = new Repository()
    repo.register("sk1", { kind: "feature" })
    repo.register("sk1/e0", { kind: "line" })
    repo.register("sk1/e0/start", { kind: "vertex" })
    expect(repo.query(absolute("sk1"))).toEqual({ kind: "feature" })
    expect(repo.query(absolute("sk1", "e0"))).toEqual({ kind: "line" })
    expect(repo.query(absolute("sk1", "e0", "start"))).toEqual({ kind: "vertex" })
  })

  it("typed local queries resolve the whole id and the slash sub key", () => {
    const repo = new Repository()
    repo.register("sk1/pwfcenter", { v: "whole" })
    repo.register("sk1/e3/start", { v: "sub" })
    expect(repo.query(local("pwfcenter"), "sk1/")).toEqual({ v: "whole" })
    expect(repo.query(local("e3", "start"), "sk1/")).toEqual({ v: "sub" })
    // A typed local built without the optional sub field reads the whole id,
    // and a miss on both the whole id and the slash key returns null.
    expect(repo.query({ kind: "local", eid: "pwfcenter" }, "sk1/")).toEqual({ v: "whole" })
    expect(repo.query(local("nope"), "sk1/")).toBeNull()
  })
})

describe("coercion scan rejection rules", () => {
  it("skips non-object, typeless, wrong-body, wrong-type and foreign-creator siblings", () => {
    const repo = new Repository()
    const bodyStore = { body_x: { id: "body_x", created_by: "ex1" } }
    const face: Payload = { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" }
    // The candidate set: a real face, a typeless payload and an array that
    // carries a type field so coerceType reaches the isDict guard.
    const typedArray = Object.assign([], { type: "flatface" }) as unknown as Payload
    repo.registerAncestor(["@ex1face0", "@ex1"], face)
    repo.registerAncestor(["@ex1face0", "@ex1"], { body_id: "body_x" })
    repo.registerAncestor(["@ex1face0", "@ex1"], typedArray)
    repo.registerAncestor(["@ex1face0", "@ex1"], "primitive-candidate")
    // Siblings sharing the @ex1 lineage token, each tripping one reject rule.
    repo.registerAncestor(["@ex1s1", "@ex1"], "raw-string")
    repo.registerAncestor(["@ex1s2", "@ex1"], [1, 2, 3])
    repo.registerAncestor(["@ex1s3", "@ex1"], { type: 42, body_id: "body_x", created_by: "ex1" })
    repo.registerAncestor(["@ex1s4", "@ex1"], { type: "straightedge", body_id: "other_body", edge_index: 0, created_by: "ex1" })
    repo.registerAncestor(["@ex1s5", "@ex1"], { type: "circleface", body_id: "body_x", created_by: "ex1" })
    repo.registerAncestor(["@ex1s6", "@ex1"], { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: 7 })
    repo.registerAncestor(["@ex1s7", "@ex1"], { type: "straightedge", body_id: "body_x", edge_index: 1, created_by: "other" })
    // The one legitimate same-body, same-creator edge.
    repo.registerAncestor(["@ex1edge", "@ex1"], { type: "straightedge", body_id: "body_x", edge_index: 2, created_by: "ex1" })
    // A dangling index key under the query's shared anchor: the coercion scan
    // must skip it rather than assume every indexed key has an entry.
    repo.byAncestorId.get("@ex1")!.add("dangling-coerce-key")

    const result = repo.query(makeAncestryQuery(["@ex1face0", "@ex1"], "edge"), null, bodyStore) as Payload
    expect(result).toMatchObject({ type: "straightedge", edge_index: 2 })
    expect(repo._lastTier).toBe("ancestral")
  })

  it("upward :solid coercion misses for a body absent from the store", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" },
    )
    expect(repo.query(makeAncestryQuery(["@ex1"], "solid"), null, { other_body: { id: "other_body" } })).toBeNull()
  })

  it("a non-object body store entry contributes no modified_by chain", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" },
    )
    // The edge's creator is a body modifier in a well-formed store, but a
    // non-object body entry has no chain to admit it, so the coercion misses.
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "fillet" },
    )
    expect(repo.query(makeAncestryQuery(["@ex1face0", "@ex1"], "edge"), null, { body_x: 42 })).toBeNull()
  })
})

describe("classifier narrowing hardening", () => {
  it("treats a non-object candidate as no evidence and resolves the matching sibling", () => {
    const repo = new Repository()
    repo.registerAncestor(["@ex1"], "primitive")
    repo.registerAncestor(["@ex1"], { type: "flatface", classifiers: ["cls_zp"] })
    const result = repo.query(makeAncestryQuery(["@ex1", "@cls_zp"])) as Payload
    expect(result.classifiers).toEqual(["cls_zp"])
    expect(repo._lastTier).toBe("ancestral")
  })
})

describe("reverse-index rot self-heal", () => {
  it("a dangling byAncestorId key resolves to nothing", () => {
    const repo = new Repository()
    repo.byAncestorId.set("@ghost", new Set(["ghost-key"]))
    expect(repo.query(makeAncestryQuery(["@ghost"]))).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("deleteAncestral ignores a missing key and a key with no index bucket", () => {
    const repo = new Repository()
    repo.registerAncestor(["@a"], { type: "flatface" })
    expect(() => repo.deleteAncestral("missing-key")).not.toThrow()
    const key = canonical(["@a"])
    repo.byAncestorId.delete("@a")
    repo.deleteAncestral(key)
    expect(repo.ancestral.has(key)).toBe(false)
  })

  it("evictAncestryAndRegister removes a dangling index-tag key", () => {
    const repo = new Repository()
    repo.byAncestorId.set("@body_x", new Set(["dead-key"]))
    evictAncestryAndRegister(repo, ["@ex1"], { type: "flatface", body_id: "body_x" }, "@body_x")
    expect(repo.byAncestorId.get("@body_x")?.has("dead-key")).toBe(false)
    expect(repo.query(makeAncestryQuery(["@ex1"]))).toMatchObject({ type: "flatface" })
  })

  it("clearBodyAncestry removes a dangling index-tag key and does not throw", () => {
    const repo = new Repository()
    repo.byAncestorId.set("@body_x", new Set(["dead-key"]))
    expect(() => clearBodyAncestry(repo, "body_x")).not.toThrow()
    expect(repo.byAncestorId.get("@body_x")?.has("dead-key")).toBe(false)
  })

  it("clearConsumedBodyAncestry returns early without a createdBy feature", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body_x/face0", "@body_x"], { type: "flatface", body_id: "body_x" })
    clearConsumedBodyAncestry(repo, "body_x", "")
    // The body range is still swept; the empty creator tag only skips the
    // solid-owner sweep, so no dangling ancestral entry is left behind.
    expect(repo.ancestral.size).toBe(0)
  })
})

describe("legacy descriptor tier", () => {
  it("narrows multiple ancestral candidates, skips malformed tokens and breaks early", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "surface:0"],
      { type: "flatface", centroid: [0, 0, 0], normal: [0, 0, 1], created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1", "surface:1"],
      { type: "flatface", centroid: [5, 0, 0], normal: [0, 0, 1], created_by: "ex1" },
    )
    // The malformed token is skipped; the tight token picks the z=0 face; the
    // trailing token makes the loop re-check and break at a single candidate.
    const q = makeAncestryQuery(
      ["@gdf|bad", "@gdf|0,0,0|0,0,1", "@gdf|0,0,0|0,0,1", "@ex1"],
      "flatface",
    )
    const result = repo.query(q) as Payload
    expect(result.centroid).toEqual([0, 0, 0])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("queryAll narrows a multi-candidate ancestral set by a descriptor", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "surface:0"],
      { type: "flatface", centroid: [0, 0, 0], normal: [0, 0, 1], created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1", "surface:1"],
      { type: "flatface", centroid: [5, 0, 0], normal: [0, 0, 1], created_by: "ex1" },
    )
    const results = repo.queryAll(makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1"])) as Payload[]
    expect(results).toHaveLength(1)
    expect(results[0].centroid).toEqual([0, 0, 0])
  })
})

describe("descriptor-only fallback", () => {
  it("filters by type and geometry before the tight match", () => {
    const repo = new Repository()
    repo.registerAncestor(["@solid"], { type: "solid", body_id: "b", created_by: "ex1" })
    repo.registerAncestor(["@nog"], { type: "flatface", body_id: "b", created_by: "ex1" })
    repo.registerAncestor(
      ["@hit"],
      { type: "flatface", centroid: [0, 0, 0], normal: [0, 0, 1], created_by: "ex1" },
    )
    // No ancestry token matches, so the fallback scans every element: the solid
    // fails the type filter and the geometry-less flatface has no descriptor.
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@none"], "flatface")
    const result = repo.query(q) as Payload
    expect(result.centroid).toEqual([0, 0, 0])
    expect(repo._lastTier).toBe("descriptor")
  })

  it("stays a miss when no descriptor token parses", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@hit"],
      { type: "flatface", centroid: [0, 0, 0], normal: [0, 0, 1], created_by: "ex1" },
    )
    expect(repo.query(makeAncestryQuery(["@gdf|bad", "@none"], "flatface"))).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })
})

describe("ordering guard treats non-object elements as builtins", () => {
  it("keeps a primitive element matchable from any feature", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["f0", "f1"])
    repo.registerAncestor(["@a"], "primitive")
    expect(repo.query(makeAncestryQuery(["@a"]), null, null, "f1")).toBe("primitive")
  })
})
