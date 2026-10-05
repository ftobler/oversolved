// Core query resolver tests: Python-scenario parity replay, parse/emit
// round-trips, local-key lookup, coercion and the partial ancestral tier. The
// other resolver sections live in the sibling query*.test.ts files.

import { describe, it, expect, beforeEach } from "vitest"
import scenarios from "./occ/__fixtures__/queryScenarios.json"
import {
  initGlobalRepo,
  evictAncestryAndRegister,
  setCurrentFeatureId,
  parseQuery,
  makeAncestryQuery,
  local,
  constructionUuidToken,
  Repository,
  AmbiguousQueryError,
} from "./query"
import { postRegister } from "./features/postRegister"
import { type Payload, makeFacePayload } from "./queryTestUtils"

type Op = Record<string, unknown>
type Query = Record<string, unknown>
type Scenario = {
  name: string
  init_builtin?: boolean
  feature_order?: string[] | null
  context_feature_id?: string
  ops?: Op[]
  queries: Query[]
}

function applyOp(repo: Repository, op: Op): void {
  switch (op.op) {
    case "register":
      repo.register(op.id as string, op.obj)
      break
    case "register_ancestor":
      repo.registerAncestor(op.ancestors as string[], op.obj)
      break
    case "evict_register":
      evictAncestryAndRegister(
        repo,
        op.ancestors as string[],
        op.obj as Record<string, unknown>,
        (op.index_tag as string) ?? null,
      )
      break
    case "gc":
      repo.gc(new Set(op.active_fids as string[]))
      break
    case "clear_sketch":
      repo.clearBySketchId(op.sketch_id as string)
      break
    default:
      throw new Error(`unknown op ${op.op}`)
  }
}

describe("query resolver parity (replay Python scenarios)", () => {
  beforeEach(() => setCurrentFeatureId(null))

  for (const scn of scenarios as Scenario[]) {
    it(scn.name, () => {
      const repo = scn.init_builtin ? initGlobalRepo() : new Repository()
      if (scn.feature_order != null) repo.setFeatureOrder(scn.feature_order)
      if (scn.context_feature_id !== undefined) setCurrentFeatureId(scn.context_feature_id)
      try {
        for (const op of scn.ops ?? []) applyOp(repo, op)
        for (const q of scn.queries) {
          const queryStr = q.query as string
          if (q.kind === "query_all") {
            const results = repo.queryAll(queryStr, (q.current_feature_id as string) ?? null)
            expect(results).toEqual(q.results)
            continue
          }
          if ("error" in q) {
            expect(() =>
              repo.query(
                queryStr,
                (q.context as string) ?? null,
                (q.body_store as Record<string, unknown>) ?? null,
                (q.current_feature_id as string) ?? null,
              ),
            ).toThrow(AmbiguousQueryError)
            continue
          }
          const result = repo.query(
            queryStr,
            (q.context as string) ?? null,
            (q.body_store as Record<string, unknown>) ?? null,
            (q.current_feature_id as string) ?? null,
          )
          expect(result ?? null).toEqual(q.result ?? null)
        }
      } finally {
        setCurrentFeatureId(null)
      }
    })
  }
})

describe("local query key shape (context + eid[/sub])", () => {
  it("string $ sub-point resolves the registered featureId/eid/sub key", () => {
    const repo = new Repository()
    repo.register("sk1/e3/start", { external_xy: [1, 2], sketch_id: "sk1" })
    expect(repo.query("$e3start", "sk1/")).toEqual({ external_xy: [1, 2], sketch_id: "sk1" })
  })

  it("string $ bare local resolves the registered featureId/eid key", () => {
    const repo = new Repository()
    repo.register("sk1/e3", { external_params: [0, 0, 1, 0], sketch_id: "sk1" })
    expect(repo.query("$e3", "sk1/")).toEqual({ external_params: [0, 0, 1, 0], sketch_id: "sk1" })
  })

  it("string $ full minted id ending in a vertex-key word wins over the suffix split", () => {
    // The kernel parser reads "$pwfYD59xKWiSyQhmstart" as eid + sub ("start" is
    // a pure word); a bare element registered under the whole string must still
    // resolve as that WHOLE id (full-id-first tie-break, same as resolveLocal /
    // resolveQueryRef), not as a shorter id plus a phantom vertex key.
    const repo = new Repository()
    repo.register("sk1/pwfYD59xKWiSyQhmstart", { v: 1, sketch_id: "sk1" })
    expect(repo.query("$pwfYD59xKWiSyQhmstart", "sk1/")).toEqual({ v: 1, sketch_id: "sk1" })
  })

  it("typed local sub-point resolves the slash key", () => {
    const repo = new Repository()
    repo.register("sk1/e3/start", { external_xy: [1, 2], sketch_id: "sk1" })
    expect(repo.query(local("e3", "start"), "sk1/")).toEqual({ external_xy: [1, 2], sketch_id: "sk1" })
  })

  it("string and typed local queries agree on a minted id ending in a vertex-key word", () => {
    // Parity: `repo.query("$...")` and `repo.query(parseQuery("$..."))` must
    // resolve the SAME way. The wire string "$pwfYD59xKWiSyQhmcenter" parses to
    // local("pwfYD59xKWiSyQhm", "center"), but a bare element registered under
    // the WHOLE id (context + eid + sub concatenated) must win the full-id-first
    // tie-break in BOTH paths.
    const repo = new Repository()
    const fullId = "sk1/pwfYD59xKWiSyQhmcenter"
    repo.register(fullId, { v: 1, sketch_id: "sk1" })
    const wire = "$pwfYD59xKWiSyQhmcenter"
    expect(repo.query(wire, "sk1/")).toEqual({ v: 1, sketch_id: "sk1" })
    expect(repo.query(parseQuery(wire), "sk1/")).toEqual({ v: 1, sketch_id: "sk1" })
  })

  it("string and typed local queries agree on the suffix-ambiguous sub shapes", () => {
    // A sub-point registered under the slash key resolves identically whether
    // it arrives as the wire string or as the parsed typed local.
    const repo = new Repository()
    repo.register("sk1/e3/start", { external_xy: [1, 2], sketch_id: "sk1" })
    repo.register("sk1/a1/xy", { external_xy: [3, 4], sketch_id: "sk1" })
    for (const wire of ["$e3start", "$a1xy"]) {
      expect(repo.query(wire, "sk1/")).toEqual(repo.query(parseQuery(wire), "sk1/"))
    }
  })

  it("postRegister slash registrations are reachable from local queries", () => {
    const repo = initGlobalRepo()
    const feature = {
      id: "sk1",
      kind: "sketch",
      plane: "@builtin_plane_front",
      entities: [{ id: "e3", kind: "line" }],
    }
    const featureResult = {
      status: "ok",
      geometry: { e3: { start: [0, 0], end: [10, 0] } },
      plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] },
    }
    postRegister(repo, "sk1", feature, featureResult)

    expect(repo.query("$e3", "sk1/")).toHaveProperty("kind", "line")
    expect(repo.query("$e3end", "sk1/")).toEqual({ external_xy: [10, 0], sketch_id: "sk1" })
    expect(repo.query(local("e3", "end"), "sk1/")).toEqual({ external_xy: [10, 0], sketch_id: "sk1" })
  })

  it("non-slash-terminated context fails loud in test mode", () => {
    const repo = new Repository()
    repo.register("sk1/e3", { v: 1 })
    expect(() => repo.query("$e3", "sk1")).toThrow()
    expect(() => repo.query(local("e3"), "sk1")).toThrow()
  })

  it("null context still returns null for local queries", () => {
    const repo = new Repository()
    repo.register("sk1/e3", { v: 1 })
    expect(repo.query("$e3")).toBeNull()
    expect(repo.query(local("e3"))).toBeNull()
  })
})


describe("query coercion", () => {
  it("coerces face to solid via body_store", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1"], "solid")
    const result = repo.query(q, null, bodyStore)
    expect(result).toBe(bodyStore["body_ex1"])
  })

  it("coerces solid to face via repo elements", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { type: "solid", body_id: "body_ex1", created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1"], "face")
    const result = repo.query(q, null, bodyStore)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("type", "flatface")
  })

  it("coerces edge to vertex via repo elements", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_ex1", edge_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1vertex0", "@ex1"],
      { type: "vertex", body_id: "body_ex1", vertex_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1edge0", "@ex1"], "vertex")
    const result = repo.query(q, null, bodyStore)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("type", "vertex")
  })

  it("exact type match takes precedence over coercion", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { type: "face", body_id: "body_ex1", created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1"],
      { type: "solid", body_id: "body_ex1", created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1"], "face")
    const result = repo.query(q, null, bodyStore)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("type", "face")
  })

  it("flatface subtype matches face restriction", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1"], "face")
    const result = repo.query(q, null, bodyStore)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("type", "flatface")
  })

  it("a contradicted subtype candidate with a classifier veto misses instead of resolving", () => {
    // The type/coerce block alone would return the lone flatface (subtype of
    // :face) BEFORE the classifier veto ran; a wanted @cls_zp over a candidate
    // carrying only cls_zn is a contradiction and must miss, never resolve the
    // contradicted element.
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { ...makeFacePayload("body_ex1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@ex1", "@cls_zp"], "face")
    expect(repo.query(q, null, bodyStore)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("a matching classifier still resolves through the subtype coerce path", () => {
    // Same lone flatface but with the wanted classifier: the classifier narrows
    // first, then the :face coerce path returns the flatface as before.
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { ...makeFacePayload("body_ex1", "ex1", 0), classifiers: ["cls_zp"] },
    )
    const q = makeAncestryQuery(["@ex1", "@cls_zp"], "face")
    const result = repo.query(q, null, bodyStore)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("type", "flatface")
    expect((result as Payload).classifiers).toEqual(["cls_zp"])
  })

  it("fails loud when body store missing for upward coercion", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1"], "solid")
    expect(() => repo.query(q)).toThrow()
    expect(() => repo.query(q, null, {})).toThrow()
  })

  it("does not coerce face to an edge outside the query's lineage", () => {
    // The only same-body edge is registered under an ancestor key sharing no
    // token with the query (a different lineage), so the old arbitrary-first
    // sibling match must miss. The edge's created_by matches the face, so the
    // miss is the ancestry scoping, not the creator check.
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex2"],
      { type: "straightedge", body_id: "body_ex1", edge_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    const result = repo.query(q, null, bodyStore)
    expect(result).toBeNull()
  })

  it("coerces face to a descendant edge within the query's lineage", () => {
    // The edge shares the query's feature token (@ex1), so it is a legitimate
    // same-lineage sibling and the coercion resolves it.
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_ex1", edge_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    const result = repo.query(q, null, bodyStore)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("type", "straightedge")
  })

  it("raises when a multi-sibling body coerces to several distinct edges", () => {
    // Two edges share the face's lineage; the sibling scan must fail loud
    // instead of first-wins onto whichever registered first.
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_ex1", edge_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge1", "@ex1"],
      { type: "straightedge", body_id: "body_ex1", edge_index: 1, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    expect(() => repo.query(q, null, bodyStore)).toThrow(AmbiguousQueryError)
  })

  it("coerces a fillet-created face to its body's solid and to an original-feature edge", () => {
    // After a fillet the face carries the modifier as created_by while the body
    // keeps the original feature's created_by; the sibling scan must admit an
    // edge whose creator is a body modifier, and upward coercion must still hit
    // the store.
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = {
      body_x: { id: "body_x", created_by: "ex1", modified_by: ["ex1", "fillet"] },
    }
    repo.registerAncestor(
      ["@body_x/face0", "@fillet", "@body_x"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "fillet" },
    )
    repo.registerAncestor(
      ["@body_x/edge0", "@ex1", "@body_x"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "ex1" },
    )
    const faceQuery = makeAncestryQuery(["@body_x/face0", "@fillet", "@body_x"])
    const solid = repo.query(makeAncestryQuery(["@body_x/face0", "@fillet", "@body_x"], "solid"), null, bodyStore)
    expect(solid).toBe(bodyStore["body_x"])
    const edge = repo.query(makeAncestryQuery(["@body_x/face0", "@fillet", "@body_x"], "edge"), null, bodyStore)
    expect(edge).not.toBeNull()
    expect(edge).toHaveProperty("type", "straightedge")
    expect(edge).toHaveProperty("created_by", "ex1")
    // The bare face query itself still resolves to the fillet face.
    expect(repo.query(faceQuery)).toHaveProperty("type", "flatface")
  })

  // Two candidates coercing to different solids is ambiguous -> fail loud.
  it("raises when coercion yields distinct solids (ambiguous)", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = {
      body_a: { id: "body_a" },
      body_b: { id: "body_b" },
    }
    repo.registerAncestor(
      ["@shared"],
      { type: "flatface", body_id: "body_a", face_index: 0, created_by: "exA" },
    )
    repo.registerAncestor(
      ["@shared"],
      { type: "flatface", body_id: "body_b", face_index: 0, created_by: "exB" },
    )
    const q = makeAncestryQuery(["@shared"], "solid")
    expect(() => repo.query(q, null, bodyStore)).toThrow(AmbiguousQueryError)
  })

  // Several faces of one body coerce to the same solid -> resolve cleanly.
  it("resolves cleanly when several faces coerce to the same solid", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@shared"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@shared"],
      { type: "flatface", body_id: "body_ex1", face_index: 1, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@shared"], "solid")
    const result = repo.query(q, null, bodyStore)
    expect(result).toBe(bodyStore["body_ex1"])
  })

  it("coerces solid to edge (downward via repo elements)", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1"],
      { type: "solid", body_id: "body_ex1", created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_ex1", edge_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1"], "edge")
    const result = repo.query(q, null, bodyStore)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty("type", "straightedge")
  })
})

/** Tests for tier-2 partial ancestral resolver.
 *
 * The resolver has three tiers:
 * 1. Full ancestral: query_set <= registered_key
 * 2. Partial ancestral: registered_key <= query_set (reverse direction, unique only)
 * 3. Geometry hash fallback */

describe("partial ancestral resolver (tier 2)", () => {
  // Query carries an extra ancestor not in registration; tier 2 resolves it.
  it("resolves when unique, extra ancestor in query not in registration", () => {
    // Registered under {A, B} but the query has {A, B, extra}
    const repo = new Repository()
    const payload = { type: "face", body_id: "body1", created_by: "ex1" }
    repo.registerAncestor(["@A", "@B"], payload, "gface_hash1")
    const result = repo.query(makeAncestryQuery(["@A", "@B", "@extra"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")
  })

  // Two elements share no common registered superset but both match tier 2.
  it("ambiguous yields no match, two entries both match tier 2 but >1 candidate", () => {
    // Query has both @A and @B, tier 1 finds nothing (query not subset of any key),
    // tier 2 finds both (@A <= query_set and @B <= query_set), returns nothing
    const repo = new Repository()
    repo.registerAncestor(["@A"], { type: "face", body_id: "body1", created_by: "ex1" }, "gface_a")
    repo.registerAncestor(["@B"], { type: "face", body_id: "body2", created_by: "ex2" }, "gface_b")
    const result = repo.query(makeAncestryQuery(["@A", "@B"]))
    expect(result).toBeNull()
  })

  // No subset relation either way, tier 2 finds nothing, falls to UUID.
  it("falls to UUID when ancestors are disjoint -- no subset relation either way", () => {
    // Query with completely different ancestors -- @X, @Y have no subset relation
    // with @A, @B, @C. Tier 1+2 miss. UUID fallback resolves via @u|u_x.
    const repo = new Repository()
    repo.registerAncestor(
      ["@A", "@B", "@C"],
      { type: "face", body_id: "body1", created_by: "ex1" },
      "u_x",
    )
    const result = repo.query(makeAncestryQuery([constructionUuidToken("u_x"), "@X", "@Y"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")
  })

  // Tier 1 exact-match candidate is returned without scanning tier 2.
  it("full match wins over partial, tier 1 exact superset returned without scanning tier 2", () => {
    // @A, @B is a subset that would match tier 2, but the full @A,@B,@C match wins
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B", "@C"], { type: "face", body_id: "body1", created_by: "full" })
    repo.registerAncestor(["@A", "@B"], { type: "face", body_id: "body2", created_by: "partial" })
    const result = repo.query(makeAncestryQuery(["@A", "@B", "@C"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("full")
  })

  // Tier 2 respects type_restriction.
  it("respects type restriction in tier 2", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@A", "@B"],
      { type: "face", body_id: "body1", created_by: "ex1" },
      "u_h1",
    )
    const result = repo.query(makeAncestryQuery([constructionUuidToken("u_h1"), "@A", "@B", "@extra"], "face"))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")

    const resultWrong = repo.query(makeAncestryQuery([constructionUuidToken("u_h1"), "@A", "@B", "@extra"], "edge"))
    expect(resultWrong).toBeNull()
  })

  // Verify that existing tier 1 behaviour (query <= key) is undisturbed.
  it("tier 1 subset still resolves, query with fewer ancestors than registered key", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B", "@C"], { type: "face", body_id: "body1", created_by: "ex1" })
    const result = repo.query(makeAncestryQuery(["@A"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")
  })
})
