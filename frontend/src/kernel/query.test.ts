import { describe, it, expect, beforeEach } from "vitest"
import scenarios from "./occ/__fixtures__/queryScenarios.json"
import {
  Repository,
  AmbiguousQueryError,
  initGlobalRepo,
  evictAncestryAndRegister,
  setCurrentFeatureId,
  featureIdxOfElement,
  isGeomHashId,
  isClassifierId,
  parseQuery,
  emitWire,
  parseAncestry,
  makeAncestryQuery,
  canonical,
  local,
  absolute,
  ancestry,
  ref,
  bodyIdOf,
  getPoint3d,
  resolvePlaneEarly,
  constructionUuidToken,
} from "./query"
import type { AncestryQuery } from "./query"
import {
  Outcome,
  DEFAULT_HEURISTIC_CONFIG,
  scoreOverlap,
  scoreGeometryLeaf,
  pickBest,
  weightFor,
} from "./queryHeuristics"
import type { HeuristicConfig } from "./queryHeuristics"
import { isPlaneType, isPointType } from "./solverConstants"
import { postRegister, clearFeatureGeometryRegistrations } from "./features/postRegister"
import { repoFromSnapshot } from "./builder"

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

describe("parse/emit round-trips", () => {
  it("local with subpoint", () => {
    expect(parseQuery("$e3start")).toEqual(local("e3", "start"))
    expect(parseQuery("$e3")).toEqual(local("e3"))
    // The wider VERTEX_POINT_KEYS suffix set (shared with utils/query) splits
    // `$mystart` into eid "my" + sub "start". The old isAlpha guard swallowed
    // real persisted sub-suffixes like `$pwfYD59xKWiSyQhmcenter`; the kernel now
    // adopts the utils set so the two serializers parse byte-identically.
    expect(parseQuery("$mystart")).toEqual(local("my", "start"))
    expect(emitWire(local("e3", "start"))).toBe("$e3start")
  })

  it("absolute feature / element / sub", () => {
    expect(parseQuery("@feat")).toEqual(absolute("feat"))
    expect(parseQuery("@feat/e0")).toEqual(absolute("feat", "e0"))
    expect(parseQuery("@feat/e0/start")).toEqual(absolute("feat", "e0", "start"))
    expect(emitWire(absolute("feat", "e0", "start"))).toBe("@feat/e0/start")
    expect(emitWire(absolute("feat"))).toBe("@feat")
  })

  it("ancestry wire round-trip with hex length headers", () => {
    const wire = makeAncestryQuery(["@feat_a", "edge:0", "@body_x"], "edge")
    const [ids, tr] = parseAncestry(wire)
    expect(ids).toEqual(["@feat_a", "edge:0", "@body_x"])
    expect(tr).toBe("edge")
    expect(emitWire(ancestry(["@feat_a", "edge:0", "@body_x"], "edge"))).toBe(wire)
  })

  // wire-format-hardening: an empty restriction IS null on the wire, so the
  // trailing ":" is never emitted. makeAncestryQuery and emitWire now agree
  // ("?2;@a:" was the old makeAncestryQuery-only asymmetry, pinned below in
  // queryWireHardening.test.ts as an accepted-but-canonicalized form).
  it("empty type restriction is null on the wire (no trailing ':')", () => {
    expect(makeAncestryQuery(["@a"], "")).toBe("?2;@a")
    expect(emitWire(ancestry(["@a"], ""))).toBe("?2;@a")
  })

  it("parseAncestry rejects truncated and bad-hex inputs", () => {
    expect(() => parseAncestry("?3;ab")).toThrow()
    expect(() => parseAncestry("?zz;abc")).toThrow()
    expect(() => parseAncestry("?3")).toThrow()
    expect(() => parseQuery("nonsense")).toThrow()
  })

  it("ref and bodyIdOf", () => {
    expect(ref("body_x")).toBe("@body_x")
    const wire = makeAncestryQuery(["@body_ex1edge0", "@body_ex1"])
    expect(bodyIdOf(wire, { body_ex1: {} })).toBe("body_ex1")
    // "body_ex1edge0" is a fabricated concatenation of the two ancestor tokens
    // ("body_ex1" + "edge0"), never a real body: it must not resolve when no
    // store (or a store holding no candidate) is present.
    expect(bodyIdOf(wire)).toBeNull()
    expect(bodyIdOf(wire, { other: {} })).toBeNull()
    expect(bodyIdOf("?1;@a")).toBeNull()

    // Slash-joined current-format token: with a store the "/face0" tail is
    // stripped and the body id verified; without one nothing is verified.
    expect(bodyIdOf(makeAncestryQuery(["@body_ex1/face0"]), { body_ex1: {} })).toBe("body_ex1")
    expect(bodyIdOf(makeAncestryQuery(["@body_ex1/face0"]))).toBeNull()
  })

  it("bodyIdOf verifies against the store and never fabricates an id", () => {
    // A legitimately-formed single body token (a split-sibling id) resolves
    // only when the store actually holds it; a no-store or no-candidate call
    // returns null rather than handing back an unverified token.
    const splitSibling = makeAncestryQuery(["@body_ex1_1"])
    expect(bodyIdOf(splitSibling, { body_ex1_1: {} })).toBe("body_ex1_1")
    expect(bodyIdOf(splitSibling)).toBeNull()
    expect(bodyIdOf(splitSibling, { body_ex1: {} })).toBeNull()
  })
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

// ─── Geom-hash fallback resolution ───

type Payload = Record<string, unknown>

function makeFacePayload(bodyId: string, createdBy: string, idx: number): Payload {
  return {
    type: "flatface",
    body_id: bodyId,
    created_by: createdBy,
    face_index: idx,
    centroid: [idx, 0.0, 0.0],
    normal: [0.0, 0.0, 1.0],
  }
}

/** Tests for two-tier ancestry resolution: ancestral primary, UUID fallback. */
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
describe("face registration structural tags", () => {
  it("face registration key has at least 3 structural tags", () => {
    const repo = new Repository()

    // Register faces with the standard 3-tag pattern + optional profile tokens
    repo.registerAncestor(
      ["@body1/face0", "@ex1", "@body1"],
      makeFacePayload("body1", "ex1", 0),
    )
    repo.registerAncestor(
      ["@body1/face1", "@ex1", "@body1", "@sk1/profileA"],
      makeFacePayload("body1", "ex1", 1),
    )
    repo.registerAncestor(
      ["@body2/face0", "@ex2", "@body2"],
      makeFacePayload("body2", "ex2", 0),
    )

    // Filter to face registrations, keys whose set contains a /face positional tag
    let foundFace = false
    for (const entry of repo.ancestral.values()) {
      const hasFaceTag = [...entry.set].some(
        (tag) =>
          typeof tag === "string" && tag.includes("/face") && tag.startsWith("@"),
      )
      if (hasFaceTag) {
        foundFace = true
        // At minimum: @body_id/faceN, @feature_id, @body_id (+ optional profile tokens)
        expect(entry.set.size).toBeGreaterThanOrEqual(3)
      }
    }
    expect(foundFace).toBe(true)
  })

  /** No geom_hash tag appears in the ancestral key Set of any face registration.
   *  This is a structural invariant: uuids live in byUuid only. */
  it("no geom_hash tag in face registration ancestral key", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/face0", "@ex1", "@body1"],
      makeFacePayload("body1", "ex1", 0),
      "gface_abc",
    )

    for (const entry of repo.ancestral.values()) {
      for (const tag of entry.set) {
        expect(isGeomHashId(tag)).toBe(false)
      }
    }

    expect(repo.byUuid.has("gface_abc")).toBe(true)
  })
})

/** Tests for the geometric-classifier predicate functions mirroring
 *  Python's TestClassifierTokenPredicate. */
describe("geometric classifier predicates", () => {
  it("recognises @cls_ prefix", () => {
    expect(isClassifierId("@cls_zp")).toBe(true)
    expect(isClassifierId("@cls_xn")).toBe(true)
  })

  it("rejects non-classifier ids", () => {
    expect(isClassifierId("@gface_abc")).toBe(false)
    expect(isClassifierId("@ex1")).toBe(false)
    expect(isClassifierId("@sk1/left")).toBe(false)
  })

  it("classifier is not a geom hash (partitions are disjoint)", () => {
    expect(isGeomHashId("@cls_zp")).toBe(false)
  })
})

/**
 * Spatial classifier tokens survive edits, resolve gracefully against contradictory input, and
 * stay consistent between query emission and element registration.
 */
describe("classifier tier resolution", () => {
  it("UUID resolves even with contradictory classifiers", () => {
    const repo = new Repository()
    const payloadP = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] }
    const payloadN = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] }
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payloadP, "u_aaa")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], payloadN, "u_bbb")

    // @cls_zp resolves the +Z cap via UUID + classifier.
    const r1 = repo.query(makeAncestryQuery([constructionUuidToken("u_aaa"), "@cls_zp", "@ex1", "@body1"]))
    expect(r1).not.toBeNull()
    expect((r1 as Payload).classifiers).toEqual(["cls_zp"])

    // Contradictory classifiers don't prevent the UUID tier from resolving.
    const contradictory = makeAncestryQuery([constructionUuidToken("u_aaa"), "@cls_zp", "@cls_zn", "@ex1", "@body1"])
    const r2 = repo.query(contradictory)
    expect(r2).not.toBeNull()
    expect((r2 as Payload).classifiers).toEqual(["cls_zp"])
  })

  /** Single source of truth: the @cls_* tokens on a query match the bare
   *  classifier list registered on the element it resolves to. */
  it("classifier on resolved element matches the query tokens", () => {
    const repo = new Repository()
    const payload = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_xp", "cls_yp"] }
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "gface_abc")

    const result = repo.query(makeAncestryQuery(["@cls_xp", "@cls_yp", "@gface_abc", "@ex1", "@body1"]))
    expect(result).not.toBeNull()
    const cls = (result as Payload).classifiers as string[]
    expect(cls).toEqual(["cls_xp", "cls_yp"])
  })

  it("split surfaces resolve by line-division classifier without index", () => {
    /** Two half-disks share ancestry {circ, cut}. Stripped of the positional
     *  surface:N index, they resolve only via the stable line-division classifier
     *  token ("cls_ld_<eid>_p" / "cls_ld_<eid>_n"). Dropping the classifier too
     *  produces an ancestral tie -> AmbiguousQueryError. */
    const repo = new Repository()
    const payloadP = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_ld_cut_p"] }
    const payloadN = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_ld_cut_n"] }

    // Register two surfaces with surface:N index for disambiguation.
    const anc0 = ["@sk1/circ", "@sk1/cut", "surface:0", "@ex1", "@body1"]
    const anc1 = ["@sk1/circ", "@sk1/cut", "surface:1", "@ex1", "@body1"]
    repo.registerAncestor(anc0, payloadP, "gface_aaa")
    repo.registerAncestor(anc1, payloadN, "gface_bbb")

    // With surface:N -> resolves (the positional index disambiguates).
    const qIndexed = makeAncestryQuery(["@sk1/circ", "@sk1/cut", "surface:0", "@ex1", "@body1"])
    expect(repo.query(qIndexed)).not.toBeNull()

    // Without index + without classifier -> ambiguous (ancestral tie).
    const qBare = makeAncestryQuery(["@sk1/circ", "@sk1/cut", "@ex1", "@body1"])
    try {
      repo.query(qBare)
      expect.fail("Should have raised AmbiguousQueryError for tied ancestors")
    } catch (e) {
      expect(e instanceof AmbiguousQueryError).toBe(true)
    }

    // With line-division classifier -> resolves via classifier tier.
    const qCls = makeAncestryQuery(["@sk1/circ", "@sk1/cut", "@cls_ld_cut_p", "@ex1", "@body1"])
    const resolved = repo.query(qCls)
    expect(resolved).not.toBeNull()
    expect((resolved as Payload).classifiers).toEqual(["cls_ld_cut_p"])
  })

  it("stale geom hash resolves via classifier after rebuild (edit-survival)", () => {
    /** The value proposition: a query captured from a short build carries
     *  a @gface_ hash. After a taller rebuild, that hash is stale (the
     *  rebuilt face has a different geometry due to the new dimensions).
     *  The @cls_ classifier, which is edit-stable, still discriminates the
     *  correct face among ancestral siblings in the new repo. */

    // Short build: two sibling faces with different classifiers.
    const shortRepo = new Repository()
    const pZp = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] }
    const pZn = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] }
    shortRepo.registerAncestor(["@ex1", "@body1", "surface:0"], pZp, "gface_short_zp")
    shortRepo.registerAncestor(["@ex1", "@body1", "surface:1"], pZn, "gface_short_zn")

    // Capture the +Z cap query from the short build.
    const captured = makeAncestryQuery(["@gface_short_zp", "@cls_zp", "@ex1", "@body1"])
    expect(shortRepo.query(captured)).not.toBeNull()

    // Tall build: same faces, same classifiers, DIFFERENT hashes.
    const tallRepo = new Repository()
    const tZp = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] }
    const tZn = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] }
    tallRepo.registerAncestor(["@ex1", "@body1", "surface:0"], tZp, "gface_tall_zp")
    tallRepo.registerAncestor(["@ex1", "@body1", "surface:1"], tZn, "gface_tall_zn")

    // The stale hash alone is ambiguous (two faces share ancestry, hash
    // doesn't match either). The resolver should raise AmbiguousQueryError.
    const staleOnly = makeAncestryQuery(["@gface_short_zp", "@ex1", "@body1"])
    try {
      tallRepo.query(staleOnly)
      expect.fail("stale hash should not match any face")
    } catch {
      // Expected: stale hash + ancestry is either null or ambiguous.
    }

    // The captured query (stale hash + @cls_zp classifier) resolves
    // to the +Z cap in the tall build via the classifier tier.
    const resolved = tallRepo.query(captured)
    expect(resolved).not.toBeNull()
    expect((resolved as Payload).classifiers).toEqual(["cls_zp"])
  })
})

/** Classifier veto semantics (classifier-disambiguation-hardening).
 *
 * A wanted @cls_* set matching no candidate is a VETO, not a silent pass: the
 * classifier tier is the only tier that kept the original candidate list when
 * the narrowing came up empty, so a lone subset candidate carrying
 * contradictory classifiers resolved wrong geometry and a multi-candidate set
 * "degraded to ambiguous" only by accident. The descriptor tier and the fillet
 * re-verify both refuse on mismatch; the classifier tier now does too. */
describe("classifier veto semantics", () => {
  it("a single subset candidate carrying contradictory classifiers misses instead of resolving", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("a single subset candidate carrying the wanted classifier still resolves", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a multi-candidate subset with a total classifier veto misses instead of resolving a wrong face", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    // Neither candidate carries the wanted cls_zp and both carry NON-EMPTY
    // contradictory evidence: the classifier veto empties the set, so the query
    // misses exactly like queryAll enumerates []. This is deliberately stronger
    // than the old behaviour (the set survived and threw AmbiguousQueryError at
    // the final multiplicity check), and it must NOT let the descriptor tier
    // shrink the set to a wrong winner.
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("an element with no classifier evidence (empty payload) is not vetoed", () => {
    // `classifiers: []` is NO evidence, not a contradiction: classifiers are
    // world-frame best-effort and a rotated body's tokens can legitimately
    // collapse to none, so the lone candidate resolves as it did before the
    // veto (the pre-existing empty OCC-B-rep edge payload asymmetry, see
    // knowledgebase). Only a non-empty payload lacking a wanted token vetoes.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: [] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual([])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a positive classifier match outranks a no-evidence sibling", () => {
    // A no-evidence candidate must not dilute the narrowing into a false
    // ambiguity: when one sibling carries the wanted cls_zp and another
    // carries [] (e.g. an edge near the body centre, or the empty OCC-B-rep
    // edge payload), the classifier resolves the positive match.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: [] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a no-evidence sibling resolves over a contradicting sibling instead of a false ambiguity", () => {
    // A MIXED set: one sibling carries non-empty CONTRADICTING evidence
    // (cls_zn) and the other carries [] (no evidence). The classifier cannot
    // disambiguate by a positive match, but the no-evidence sibling is the
    // only non-contradicted candidate and must resolve, where keeping the
    // full set pre-feature would have thrown AmbiguousQueryError (the B1 fix).
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: [] },
    )
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual([])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("the ancestral-partial tier filters classifiers before its single-hit return", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@A"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    // query_set {@A, @extra} is not a subset of the registered {@A}, so the
    // exact tier misses; the partial tier sees one candidate carrying cls_zn.
    // A wanted cls_zp must veto it (miss), not resolve it as ancestral-partial.
    const wrong = makeAncestryQuery(["@A", "@extra", "@cls_zp"])
    expect(repo.query(wrong)).toBeNull()
    expect(repo._lastTier).toBe("miss")

    // The matching classifier still resolves through the partial tier.
    const right = makeAncestryQuery(["@A", "@extra", "@cls_zn"])
    const result = repo.query(right)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zn"])
    expect(repo._lastTier).toBe("ancestral-partial")
  })

  it("a multi-candidate classifier veto is not re-bypassed by legacy descriptor tokens", () => {
    // Two sibling caps share the ancestry tokens and BOTH carry NON-EMPTY
    // contradictory evidence (cls_zn against the wanted cls_zp). The legacy
    // descriptor token names the surface:0 face tightly, so the descriptor tier
    // (and, after the veto empties the set, the descriptor-only fallback) would
    // each pick a wrong face. The veto must win either way.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("the descriptor-only fallback cannot resolve a vetoed contradictory candidate either", () => {
    // Same veto, but the candidates share EXACTLY the query's non-hash tokens:
    // after the veto empties the subset set, the ancestral-partial tier sees
    // them again (and narrows them to []), and the descriptor-only fallback
    // then tight-matches the surface:0 face over the WHOLE repo with no
    // classifier re-check. It must stay a miss.
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("a positive classifier match outranks a legacy descriptor token", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zp"] },
    )
    // The descriptor names the cls_zn face (centroid [0,0,0]) but the wanted
    // cls_zp is real positive evidence on the other sibling and must outrank it.
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_zp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("a partial classifier overlap is positive evidence, not a contradiction", () => {
    // The wanted set {xp, yp} snapshots an earlier geometry; the +Y sibling lost
    // its cls_xp when the model moved it. Its cls_yp is partial positive
    // evidence, so the veto must NOT fire and the sibling resolves (the
    // persisted plane-on-face rescue, pickIdentityCorpus).
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_yn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_yp"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_xp", "@cls_yp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_yp"])
    expect(repo._lastTier).toBe("ancestral")
  })

  it("queryAll enumerates the partial-overlap sibling, matching the resolver", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_yn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_yp"] },
    )
    // Same fixture as the resolver pin above: queryAll must enumerate exactly
    // the partial-overlap sibling, not the zero-overlap one and not the empty
    // whole set.
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_xp", "@cls_yp"])
    const results = repo.queryAll(q) as Payload[]
    expect(results.length).toBe(1)
    expect(results[0].classifiers).toEqual(["cls_yp"])
  })

  it("partial positive evidence outranks a no-evidence sibling in both resolver and queryAll", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_xp"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: [] },
    )
    // The cls_xp sibling shares a wanted token and is positive evidence; the []
    // payload is no evidence. Per the documented priority the partial match
    // must outrank the no-evidence sibling in both the resolver and queryAll,
    // or the tier order is wrong.
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_xp", "@cls_yp"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual(["cls_xp"])
    expect(repo._lastTier).toBe("ancestral")
    const results = repo.queryAll(q) as Payload[]
    expect(results.length).toBe(1)
    expect(results[0].classifiers).toEqual(["cls_xp"])
  })

  it("the resolver veto and queryAll enumeration agree on a contradictory multi-candidate set", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:0"],
      { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zn"] },
    )
    repo.registerAncestor(
      ["@ex1", "@body1", "surface:1"],
      { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] },
    )
    const q = makeAncestryQuery(["@gdf|0,0,0|0,0,1", "@ex1", "@body1", "@cls_zp"])
    expect(repo.query(q)).toBeNull()
    expect(repo.queryAll(q)).toEqual([])
  })
})

describe("restored snapshot with a non-array classifiers payload", () => {
  it("resolves without throwing when the classifier payload is not an array", () => {
    // A snapshot-restored repo is the untrusted route: an element whose
    // `classifiers` field is not an array (a string, number, object) must be
    // treated as NO evidence inside narrowByClassifier, never throw TypeError.
    // A sibling with real matching evidence outranks it; without the guard the
    // whole narrow would crash before reaching that ranking.
    const snapshot = {
      elements: {
        el0: { type: "flatface", classifiers: 42 },
        el1: { type: "flatface", classifiers: ["cls_zp"] },
      },
      ancestral: {
        [canonical(["@ex1", "@body1"])]: { set: ["@ex1", "@body1"], eids: ["el0", "el1"] },
      },
      byUuid: {},
    }
    const repo = repoFromSnapshot(snapshot)
    const q = makeAncestryQuery(["@ex1", "@body1", "@cls_zp"])
    expect(() => repo.query(q)).not.toThrow()
    expect(repo.query(q)).toBe(repo.elements.get("el1"))
    expect(() => repo.queryAll(q)).not.toThrow()
    expect(repo.queryAll(q)).toEqual([repo.elements.get("el1")])
  })
})

/** World-frame best-effort classifier contract (classifier-disambiguation-hardening).
 *
 * Classifiers are minted against the world-frame AABB, so a rotated body's
 * side faces can collapse to empty or contradictory token sets (see
 * geomHash.test.ts). The construction `@u|` UUID is the PRIMARY tier: a query
 * naming the uuid resolves the element regardless of what its classifiers look
 * like, so the collapse only ever weakens the stale-uuid fallback, never the
 * primary identity. */
describe("world-frame best-effort classifier contract", () => {
  it("a rotated body's face resolves via its @u| uuid even when classifiers collapse to empty", () => {
    const repo = new Repository()
    // The world-frame AABB of a rotated square prism mints no classifier for
    // some side faces (the collapse); the uuid tier must still resolve it.
    const collapsed = { ...makeFacePayload("body1", "ex1", 0), classifiers: [] }
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], collapsed, "u_rot")
    const q = makeAncestryQuery([constructionUuidToken("u_rot"), "@cls_zp", "@ex1", "@body1"])
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Payload).classifiers).toEqual([])
    expect(repo._lastTier).toBe("uuid")
  })
})

describe("ambiguous ancestry queries", () => {
  /** Direct test: manually create a scenario where the repository has
   *  multiple elements with overlapping ancestor sets. */
  it("raises when two surfaces share the same ancestor set", () => {
    const repo = new Repository()
    const ancestorIds = ["@sketch_1/circle", "@sketch_1/right_line"]
    const query = makeAncestryQuery(ancestorIds, "face")

    repo.registerAncestor(ancestorIds, { type: "face", id: "surface1" })
    repo.registerAncestor(ancestorIds, { type: "face", id: "surface2" })

    try {
      repo.query(query)
      expect.fail("Should have raised AmbiguousQueryError")
    } catch (e) {
      expect(e instanceof AmbiguousQueryError).toBe(true)
      expect(String(e)).toContain("matched 2")
    }
  })

  // Test that adding surface indices to ancestor IDs disambiguates queries.
  it("surface index disambiguates queries", () => {
    const ancestorIds = ["@sketch_1/circle", "@sketch_1/right_line"]
    const query1 = makeAncestryQuery(ancestorIds, "face")
    const query2 = makeAncestryQuery(ancestorIds, "face")
    expect(query1).toBe(query2)

    const ancestorIds0 = ["@sketch_1/circle", "@sketch_1/right_line", "surface:0"]
    const ancestorIds1 = ["@sketch_1/circle", "@sketch_1/right_line", "surface:1"]

    const query1Indexed = makeAncestryQuery(ancestorIds0, "face")
    const query2Indexed = makeAncestryQuery(ancestorIds1, "face")

    expect(query1Indexed).not.toBe(query2Indexed)
  })

  // Test that indexed queries resolve to a single surface, not both.
  it("indexed queries resolve to a single surface each", () => {
    const repo = new Repository()

    const ancestorIds0 = ["@sketch_1/circle", "@sketch_1/right_line", "surface:0"]
    const ancestorIds1 = ["@sketch_1/circle", "@sketch_1/right_line", "surface:1"]

    const query0 = makeAncestryQuery(ancestorIds0, "face")
    const query1 = makeAncestryQuery(ancestorIds1, "face")

    const surface0Id = repo.registerAncestor(ancestorIds0, { type: "face", id: "surface0" })
    const surface1Id = repo.registerAncestor(ancestorIds1, { type: "face", id: "surface1" })

    const result0 = repo.query(query0) as Record<string, unknown> | null
    const result1 = repo.query(query1) as Record<string, unknown> | null

    expect(result0).not.toBeNull()
    expect(result1).not.toBeNull()
    expect(result0!.id).toBe("surface0")
    expect(result1!.id).toBe("surface1")
    expect(repo.elements.has(surface0Id)).toBe(true)
    expect(repo.elements.has(surface1Id)).toBe(true)
  })
})

/** Characterization tests: type coercion is exact-tier only.
 *
 * _resolve_ancestry_ids attempts _coerce_type ONLY when the exact tier
 * (query_set <= registered_key) produced candidates. The recovery tiers
 * filter by strict type and never coerce. This is intentional: once we are
 * already guessing (partial or hash-only match), type coercion widens the
 * guess and invites a fail-wrong pick. */
describe("type coercion tier scope", () => {
  const flatfaceObj = {
    type: "flatface",
    body_id: "body_ex1",
    face_index: 0,
    created_by: "ex1",
  }
  const bodyObj = { id: "body_ex1" }
  const bodyStoreWithSolid = { body_ex1: bodyObj }

  function repoWithFlatface(ancestors: string[], uuid?: string): Repository {
    const repo = new Repository()
    repo.registerAncestor(ancestors, flatfaceObj, uuid ?? null)
    return repo
  }

  // Baseline: an exact-tier flatface coerces up to its solid.
  it("coercion happens in exact tier", () => {
    const repo = repoWithFlatface(["@A"])
    const q = makeAncestryQuery(["@A"], "solid")
    expect(repo.query(q, null, bodyStoreWithSolid)).toBe(bodyObj)
  })

  /** Same flatface reached via the partial tier (query carries an extra id)
   *  does NOT coerce to solid -- strict type filter -> no match. */
  it("coercion skipped in partial tier (type strict filter drops match)", () => {
    const repo = repoWithFlatface(["@A"])
    // query_set {@A, @extra} is not a subset of {@A}, so the exact tier misses
    // and the partial tier ({@A} <= {@A, @extra}) is what fires
    const q = makeAncestryQuery(["@A", "@extra"], "solid")
    expect(repo.query(q, null, bodyStoreWithSolid)).toBeNull()
  })

  // Contrast: the same partial match resolves fine when no type is demanded.
  it("partial tier resolves without type restriction", () => {
    const repo = repoWithFlatface(["@A"])
    const q = makeAncestryQuery(["@A", "@extra"])
    const result = repo.query(q, null, bodyStoreWithSolid)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).type).toBe("flatface")
  })

  // A face reached only via the UUID tier does NOT coerce.
  it("coercion skipped in UUID tier (no ancestry = strict type filter)", () => {
    const repo = repoWithFlatface(["@A"], "u_h")
    // @X shares no subset relation with @A (tiers 1+2 miss); only the UUID
    // matches. With type_restriction=solid the strict filter drops it.
    const q = makeAncestryQuery([constructionUuidToken("u_h"), "@X"], "solid")
    expect(repo.query(q, null, bodyStoreWithSolid)).toBeNull()
  })

  // Contrast: the UUID fallback resolves the face when no type is demanded.
  it("UUID fallback resolves without type restriction", () => {
    const repo = repoWithFlatface(["@A"], "u_h")
    const q = makeAncestryQuery([constructionUuidToken("u_h"), "@X"])
    const result = repo.query(q, null, bodyStoreWithSolid)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).type).toBe("flatface")
  })
})

describe("coerceType scoped to same created_by feature", () => {
  it("coerces within the same feature", () => {
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
    const result = repo.query(q, null, bodyStore) as Record<string, unknown> | null
    expect(result).not.toBeNull()
    expect(result!.type).toBe("straightedge")
  })

  it("does not coerce across features (different created_by on same body_id)", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { shared_body: { id: "shared_body" } }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "shared_body", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex2edge0", "@ex2"],
      { type: "straightedge", body_id: "shared_body", edge_index: 0, created_by: "ex2" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    const result = repo.query(q, null, bodyStore)
    expect(result).toBeNull()
  })

  it("rejects coercion when created_by is missing", () => {
    const repo = new Repository()
    const bodyStore: Record<string, unknown> = { body_ex1: { id: "body_ex1" } }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0 },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_ex1", edge_index: 0 },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    const result = repo.query(q, null, bodyStore)
    expect(result).toBeNull()
  })
})

/** Ordering guard: a query from feature N must never resolve against geometry
 * owned by a feature ordered after N in the current build order. */
describe("ordering guard", () => {
  function reg(
    repo: Repository,
    ancestors: string[],
    owner: string,
    uuid?: string,
    type = "face",
  ): string {
    return repo.registerAncestor(ancestors, { type, created_by: owner }, uuid ?? null)
  }

  it("filters forward references after reorder", () => {
    // Both extrudes are built on sk1, so a broad query for @sk1 matches both.
    // From ex1 the ex2-owned element is forward and must be filtered out.
    const repo = new Repository()
    repo.setFeatureOrder(["sk1", "ex1", "ex2"])
    reg(repo, ["@sk1"], "ex1")
    reg(repo, ["@sk1"], "ex2")
    const q: AncestryQuery = { kind: "ancestry", ancestorIds: ["@sk1"], typeRestriction: null }

    const resolved = repo.query(q, null, null, "ex1") as Record<string, unknown>
    expect(resolved).not.toBeNull()
    expect(resolved.created_by).toBe("ex1")
  })

  it("builtin elements are never ordering-gated", () => {
    // No created_by/sketch_id => built-in, never ordering-gated
    const repo = new Repository()
    repo.setFeatureOrder(["f0", "f1"])
    repo.registerAncestor(["@builtin"], { type: "plane" })
    const q: AncestryQuery = { kind: "ancestry", ancestorIds: ["@builtin"], typeRestriction: null }

    const resolved = repo.query(q, null, null, "f0") as Record<string, unknown>
    expect(resolved).not.toBeNull()
    expect(resolved.type).toBe("plane")
  })

  it("featureIdxOfElement returns null for built-in element", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["f0"])
    const eid = repo.registerAncestor(["@builtin"], { type: "plane" })

    expect(featureIdxOfElement(repo, eid)).toBeNull()
  })

  it("absolute queries are never ordering-gated", () => {
    // Absolute references are explicit and not ordering-gated, even forward.
    const repo = new Repository()
    repo.setFeatureOrder(["ex1", "ex2"])
    repo.register("ex2/vertex/2", { type: "vertex", created_by: "ex2" })

    const resolved = repo.query("@ex2/vertex/2", null, null, "ex1") as Record<string, unknown>
    expect(resolved).not.toBeNull()
    expect(resolved.created_by).toBe("ex2")
  })

  it("queryAll respects ordering guard", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["sk1", "sk2"])
    reg(repo, ["@sk1"], "sk1")
    reg(repo, ["@sk1"], "sk2")
    const qs = emitWire(ancestry(["@sk1"]))

    const results = repo.queryAll(qs, "sk1") as Record<string, unknown>[]
    const owners = new Set(results.map(r => r.created_by as string))
    expect(owners).toEqual(new Set(["sk1"]))
  })

  it("ordering guard is no-op without current feature", () => {
    // No current feature => filter is identity, both match → ambiguous
    const repo = new Repository()
    repo.setFeatureOrder(["ex1", "ex2"])
    reg(repo, ["@sk1"], "ex1")
    reg(repo, ["@sk1"], "ex2")
    const q: AncestryQuery = { kind: "ancestry", ancestorIds: ["@sk1"], typeRestriction: null }

    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("UUID fallback rejects forward match", () => {
    // Identical UUID, distinct ancestry; query carries only the UUID so
    // resolution lands in the UUID tier.
    const repo = new Repository()
    repo.setFeatureOrder(["f0", "f1"])
    reg(repo, ["@f0"], "f0", "u_X")
    reg(repo, ["@f1"], "f1", "u_X")
    const q = ancestry([constructionUuidToken("u_X")])

    // Collision-first semantics: the multiplicity check counts ALL live hits in
    // the bucket before the ordering filter, so two live elements sharing one
    // uuid is a loud collision, never a silent narrowing to the earlier one.
    expect(() => repo.query(q, null, null, "f0")).toThrow(AmbiguousQueryError)
  })

  it("contextvar drives the ordering guard", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["ex1", "ex2"])
    reg(repo, ["@sk1"], "ex1")
    reg(repo, ["@sk1"], "ex2")
    const q = ancestry(["@sk1"])

    setCurrentFeatureId("ex1")
    try {
      const resolved = repo.query(q) as Record<string, unknown>
      expect(resolved).not.toBeNull()
      expect(resolved.created_by).toBe("ex1")
    } finally {
      setCurrentFeatureId(null)
    }
  })

  it("orphaned owner (not in feature index) is excluded from an earlier feature's query", () => {
    // The element's created_by names a feature no longer in the order; the
    // guard must not treat it as built-in and must not leak it forward.
    const repo = new Repository()
    repo.setFeatureOrder(["sk1", "ex1"])
    reg(repo, ["@sk1"], "dead_feature")
    const q: AncestryQuery = { kind: "ancestry", ancestorIds: ["@sk1"], typeRestriction: null }

    expect(repo.query(q)).not.toBeNull()
    expect(repo.query(q, null, null, "ex1")).toBeNull()
  })

  it("built-in (no owner) stays matchable while orphaned is excluded", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["f0", "f1"])
    reg(repo, ["@sk1"], "dead_feature")
    repo.registerAncestor(["@builtin"], { type: "plane" })

    expect(repo.query(makeAncestryQuery(["@sk1"]), null, null, "f0")).toBeNull()
    expect(repo.query(makeAncestryQuery(["@builtin"]), null, null, "f0")).not.toBeNull()
  })

  it("unknown currentFeatureId fails loud instead of silently disabling the guard", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["f0", "f1"])
    reg(repo, ["@sk1"], "f0")
    const q: AncestryQuery = { kind: "ancestry", ancestorIds: ["@sk1"], typeRestriction: null }

    expect(() => repo.query(q, null, null, "not_a_feature")).toThrow()
  })
})

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
describe("ordering guard: coerce scan", () => {
  it("rejects a later-feature sibling during coercion (forward geometry)", () => {
    // Repro: featureOrder [ex0, ex1, fillet]. The face coerces to an edge and
    // the only matching sibling is owned by the LATER 'fillet' (a body
    // modifier). The guard must refuse it exactly as it refuses forward
    // references in the ancestry tiers, so the coercion misses.
    const repo = new Repository()
    repo.setFeatureOrder(["ex0", "ex1", "fillet"])
    const bodyStore: Record<string, unknown> = {
      body_x: { id: "body_x", created_by: "ex1", modified_by: ["ex1", "fillet"] },
    }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "fillet" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    const result = repo.query(q, null, bodyStore, "ex1")
    expect(result).toBeNull()
  })

  it("still coerces to a same-feature sibling under the guard", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["ex0", "ex1", "fillet"])
    const bodyStore: Record<string, unknown> = {
      body_x: { id: "body_x", created_by: "ex1", modified_by: ["ex1"] },
    }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    const result = repo.query(q, null, bodyStore, "ex1") as Record<string, unknown> | null
    expect(result).not.toBeNull()
    expect(result!.created_by).toBe("ex1")
  })

  it("a later feature may still coerce to an earlier feature's sibling (backward reference)", () => {
    // From 'fillet' the ex1-owned edge is a backward reference and stays legal.
    const repo = new Repository()
    repo.setFeatureOrder(["ex0", "ex1", "fillet"])
    const bodyStore: Record<string, unknown> = {
      body_x: { id: "body_x", created_by: "ex1", modified_by: ["ex1", "fillet"] },
    }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "fillet" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")
    const result = repo.query(q, null, bodyStore, "fillet") as Record<string, unknown> | null
    expect(result).not.toBeNull()
    expect(result!.created_by).toBe("ex1")
  })

  it("queryAll applies the guard to the coerce scan", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["ex0", "ex1", "fillet"])
    const bodyStore: Record<string, unknown> = {
      body_x: { id: "body_x", created_by: "ex1", modified_by: ["ex1", "fillet"] },
    }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "fillet" },
    )
    const results = repo.queryAll(makeAncestryQuery(["@ex1"], "edge"), "ex1", bodyStore)
    expect(results).toEqual([])
  })

  it("queryAllTyped applies the guard to the coerce scan", () => {
    const repo = new Repository()
    repo.setFeatureOrder(["ex0", "ex1", "fillet"])
    const bodyStore: Record<string, unknown> = {
      body_x: { id: "body_x", created_by: "ex1", modified_by: ["ex1", "fillet"] },
    }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "fillet" },
    )
    const results = repo.queryAllTyped(ancestry(["@ex1"], "edge"), "ex1", bodyStore)
    expect(results).toEqual([])
  })

  it("contextvar drives the guard for the coerce scan", () => {
    // The production solve loop sets the module contextvar instead of passing
    // currentFeatureId explicitly; the coerce scan must honor it the same way.
    // No explicit currentFeatureId is passed, so orderFilter falls back to the
    // contextvar and the fillet-owned sibling stays hidden from 'ex1'.
    const repo = new Repository()
    repo.setFeatureOrder(["ex0", "ex1", "fillet"])
    const bodyStore: Record<string, unknown> = {
      body_x: { id: "body_x", created_by: "ex1", modified_by: ["ex1", "fillet"] },
    }
    repo.registerAncestor(
      ["@ex1face0", "@ex1"],
      { type: "flatface", body_id: "body_x", face_index: 0, created_by: "ex1" },
    )
    repo.registerAncestor(
      ["@ex1edge0", "@ex1"],
      { type: "straightedge", body_id: "body_x", edge_index: 0, created_by: "fillet" },
    )
    const q = makeAncestryQuery(["@ex1face0", "@ex1"], "edge")

    setCurrentFeatureId("ex1")
    try {
      const result = repo.query(q, null, bodyStore)
      expect(result).toBeNull()
    } finally {
      setCurrentFeatureId(null)
    }
  })
})

describe("topology ordering stamp", () => {
  function sketchCase(topology: Record<string, unknown>): {
    feature: Record<string, unknown>
    featureResult: Record<string, unknown>
  } {
    return {
      feature: { id: "sk2", kind: "sketch", plane: "@builtin_plane_front", entities: [] },
      featureResult: {
        status: "ok",
        geometry: {},
        plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] },
        topology,
      },
    }
  }

  it("stamps topology payloads with the owning sketch_id", () => {
    const repo = initGlobalRepo()
    const { feature, featureResult } = sketchCase({
      surfaces: [{ query: "?9;@sk2/prof", boundary: [] }],
      edges: [{ query: "?7;@sk2/e0", start: [0, 0], end: [10, 0], kind: "line" }],
      vertices: { v1: { x: 1, y: 2 } },
    })
    postRegister(repo, "sk2", feature, featureResult)

    const surface = repo.query(makeAncestryQuery(["@sk2/prof"])) as Record<string, unknown>
    expect(surface).not.toBeNull()
    expect(surface).toHaveProperty("sketch_id", "sk2")

    const edge = repo.query(makeAncestryQuery(["@sk2/e0"])) as Record<string, unknown>
    expect(edge).not.toBeNull()
    expect(edge).toHaveProperty("sketch_id", "sk2")

    const vertex = repo.query(makeAncestryQuery(["v1", "vertex", "@sk2"])) as Record<string, unknown>
    expect(vertex).not.toBeNull()
    expect(vertex).toHaveProperty("sketch_id", "sk2")
  })

  it("a later sketch's topology is excluded from an earlier feature's query", () => {
    const repo = initGlobalRepo()
    const { feature, featureResult } = sketchCase({
      surfaces: [{ query: "?9;@sk2/prof", boundary: [] }],
      edges: [],
      vertices: {},
    })
    postRegister(repo, "sk2", feature, featureResult)

    repo.setFeatureOrder(["sk1", "sk2"])
    expect(repo.query(makeAncestryQuery(["@sk2/prof"]))).not.toBeNull()
    expect(repo.query(makeAncestryQuery(["@sk2/prof"]), null, null, "sk1")).toBeNull()
  })
})

/** Characterization tests for feature-geometry registration cleanup.
 *
 * clear_by_sketch_id is elements-only: it removes direct payloads but does NOT
 * prune the ancestral index. Used standalone it can leave dangling refs. The
 * orchestrated clear_feature_geometry_registrations prunes both together. */
describe("clearBySketchId", () => {
  it("can leave dangling refs when used standalone", () => {
    // clear_by_sketch_id removes every elements entry carrying the sketch_id
    // but does NOT prune the ancestral index. Used standalone it can leave
    // dangling refs: a token still listed in ancestral but absent from elements.
    const repo = new Repository()
    const eid = repo.registerAncestor(
      ["@sketch1/line1", "@sketch1"],
      { type: "flatface", sketch_id: "sketch1" },
    )
    repo.register("sketch1/line1", { external_params: [0, 0, 1, 0], sketch_id: "sketch1" })

    repo.clearBySketchId("sketch1")

    expect(repo.elements.has("sketch1/line1")).toBe(false)
    expect(repo.elements.has(eid)).toBe(false)
    const hasDangling = [...repo.ancestral.values()].some(entry => entry.eids.includes(eid))
    expect(hasDangling).toBe(true)
  })
})

/** Dead (dangling) eids must never count toward ambiguity or become the winner.
 *  The uuid tier and queryAll already filter by liveness; the ancestral subset,
 *  partial and descriptor tiers must do the same, and _lastTier must stay honest
 *  (a candidate list empty after the liveness filter is a miss, not a resolve). */
describe("dead eid ambiguity filter", () => {
  it("untyped query over an all-dead entry misses instead of throwing", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@sketch1/line1", "@sketch1"],
      { type: "flatface", sketch_id: "sketch1" },
    )
    repo.registerAncestor(
      ["@sketch1/line1", "@sketch1"],
      { type: "flatface", sketch_id: "sketch1" },
    )
    repo.register("sketch1/line1", { external_params: [0, 0, 1, 0], sketch_id: "sketch1" })

    repo.clearBySketchId("sketch1")

    const result = repo.query(makeAncestryQuery(["@sketch1/line1", "@sketch1"]))
    expect(result).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("mixed live+dead candidates resolve the live element", () => {
    const repo = new Repository()
    const live = { type: "flatface", id: "live", sketch_id: "sketch1" }
    repo.registerAncestor(["@sketch1"], live)
    const deadEid = repo.registerAncestor([
      "@sketch1",
    ], { type: "flatface", id: "dead", sketch_id: "sketch1" })
    repo.deleteElement(deadEid)

    const result = repo.query(makeAncestryQuery(["@sketch1"]))
    expect(result).toBe(live)
    expect(repo._lastTier).toBe("ancestral")
  })

  it("two genuinely live candidates still throw AmbiguousQueryError", () => {
    const repo = new Repository()
    repo.registerAncestor(["@sketch1"], { type: "flatface", id: "a", sketch_id: "sketch1" })
    repo.registerAncestor(["@sketch1"], { type: "flatface", id: "b", sketch_id: "sketch1" })

    expect(() => repo.query(makeAncestryQuery(["@sketch1"]))).toThrow(AmbiguousQueryError)
  })

  it("partial tier ignores dead eids", () => {
    const repo = new Repository()
    const deadEid = repo.registerAncestor(["@A"], { type: "flatface", sketch_id: "sketch1" })
    repo.deleteElement(deadEid)

    const result = repo.query(makeAncestryQuery(["@A", "@extra"]))
    expect(result).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })

  it("descriptor-only fallback never returns a dead element", () => {
    const repo = new Repository()
    const deadEid = repo.registerAncestor(
      ["@ex1", "@body1"],
      { type: "flatface", centroid: [0, 0, 10], normal: [0, 0, 1], sketch_id: "sketch1" },
    )
    repo.deleteElement(deadEid)

    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@X", "@Y"], "flatface")
    const result = repo.query(q)
    expect(result).toBeNull()
    expect(repo._lastTier).toBe("miss")
  })
})

/** The orchestration prunes ancestral + elements together, leaving no
 * dangling eid: every eid listed in any ancestral list still exists in elements. */
describe("clearFeatureGeometryRegistrations", () => {
  // The orchestration prunes ancestral + elements together: no dangling eid.
  it("leaves no dangling refs after cleanup", () => {
    const repo = new Repository()
    const topoEid = repo.registerAncestor(
      ["@sketch1/line1", "surface:0", "@sketch1"],
      { type: "flatface", sketch_id: "sketch1" },
    )
    repo.register("sketch1/line1", { external_params: [0, 0, 1, 0], sketch_id: "sketch1" })
    repo.register("sketch1/line1/start", { external_xy: [0, 0], sketch_id: "sketch1" })
    const otherEid = repo.registerAncestor(
      ["@sketch2/line1", "@sketch2"],
      { type: "flatface", sketch_id: "sketch2" },
    )

    clearFeatureGeometryRegistrations(repo, "sketch1")

    for (const entry of repo.ancestral.values()) {
      for (const eid of entry.eids) {
        expect(repo.elements.has(eid)).toBe(true)
      }
    }

    expect(repo.elements.has(topoEid)).toBe(false)
    expect(repo.elements.has("sketch1/line1")).toBe(false)
    expect(repo.elements.has("sketch1/line1/start")).toBe(false)

    expect(repo.elements.has(otherEid)).toBe(true)
  })
})

// ─── repoFromSnapshot ───

function buildRepoWithPayloads(count: number): Repository {
  const repo = new Repository()
  for (let i = 0; i < count; i++) {
    const eid = `e${i}`
    repo.elements.set(eid, {
      id: eid,
      kind: "line",
      params: Array.from({ length: 8 }, (_, j) => j),
    })
    const ancKey = canonical([`body_${i}`])
    const childIds = Array.from({ length: 3 }, (_, j) => `e${(i + j) % count}`)
    repo.ancestral.set(ancKey, { set: new Set([`body_${i}`]), eids: childIds })
  }
  return repo
}

function makeSnapshot(repo: Repository): Record<string, unknown> {
  const elements: Record<string, unknown> = {}
  for (const [k, v] of repo.elements) elements[k] = v
  const ancestral: Record<string, { set: string[]; eids: string[] }> = {}
  for (const [k, entry] of repo.ancestral) {
    ancestral[k] = { set: [...entry.set], eids: [...entry.eids] }
  }
  const byUuid: Record<string, string[]> = {}
  for (const [k, v] of repo.byUuid) byUuid[k] = [...v]
  return { elements, ancestral, byUuid }
}

/** Tests for repo snapshot shallow copy memory and correctness. */
describe("repoFromSnapshot", () => {
  // _repo_from_snapshot with shallow copy produces same query results.
  it("preserves correctness with payloads", () => {
    const original = buildRepoWithPayloads(100)
    const snapshot = makeSnapshot(original)

    const repo = repoFromSnapshot(snapshot)

    for (const [eid, val] of original.elements) {
      expect(repo.elements.get(eid)).toEqual(val)
    }
    expect(new Set(repo.ancestral.keys())).toEqual(new Set(original.ancestral.keys()))
  })

  /** dict() copy uses less memory than deepcopy for the same payloads,
   *  shallow copies share value objects instead of duplicating them. */
  it("shallow copy isolates eids arrays from snapshot source", () => {
    const original = buildRepoWithPayloads(500)
    const snapshot = makeSnapshot(original)

    const repo = repoFromSnapshot(snapshot)

    for (const [eid, val] of original.elements) {
      expect(repo.elements.get(eid)).toEqual(val)
    }

    const snapshotAncestral = snapshot.ancestral as Record<
      string,
      { set: string[]; eids: string[] }
    >
    const firstKey = Object.keys(snapshotAncestral)[0]
    const snapshotEids = snapshotAncestral[firstKey].eids
    const origLen = snapshotEids.length
    snapshotEids.push("extra")

    const repoEntry = repo.ancestral.get(firstKey)
    expect(repoEntry).not.toBeUndefined()
    expect(repoEntry!.eids.length).toBe(origLen)
  })

  // Appending to an ancestral list in deserialized repo does not affect snapshot.
  it("isolates ancestral lists from snapshot", () => {
    const repo = buildRepoWithPayloads(10)
    const snapshot = makeSnapshot(repo)

    const cp = repoFromSnapshot(snapshot)
    const existingKey = cp.ancestral.keys().next().value as string
    expect(existingKey).toBeDefined()

    const snapshotAncestral = snapshot.ancestral as Record<
      string,
      { set: string[]; eids: string[] }
    >
    expect(existingKey in snapshotAncestral).toBe(true)
    expect(snapshotAncestral[existingKey].eids.length).toBe(3)
  })

  // Empty snapshot produces empty repo.
  it("handles empty snapshot", () => {
    const repo = repoFromSnapshot({ elements: {}, ancestral: {}, byUuid: {} })
    expect(repo.elements.size).toBe(0)
    expect(repo.ancestral.size).toBe(0)
  })

  // Old-format snapshot (no elements/ancestral keys) returns empty repo.
  it("returns empty repo for old-format snapshot (no elements/ancestral wrapper)", () => {
    const oldSnapshot = { e1: { id: "e1", kind: "point", params: [1.0, 2.0] } }
    const repo = repoFromSnapshot(oldSnapshot)
    expect(repo.elements.size).toBe(0)
    expect(repo.ancestral.size).toBe(0)
  })
})

// ─── Ancestral registry lifecycle ───

/** Tests for the ancestral registry lifecycle: re-registration, GC, reset on
 * geometry changes. Exercised via _evict_ancestry_and_register, postRegister,
 * and clear_feature_geometry_registrations. */
describe("ancestral registry lifecycle", () => {
  function ancestralCountForQuery(repo: Repository, query: string): number {
    const [ids] = parseAncestry(query)
    const key = canonical(ids)
    return repo.ancestral.get(key)?.eids.length ?? 0
  }

  it("edge no accumulation on re-registers", () => {
    const repo = new Repository()
    const edgeQuery = "?2,4;e1line"
    const [ids] = parseAncestry(edgeQuery)
    const edgeData = { type: "straightedge", kind: "line", start: [0, 0, 0], end: [1, 0, 0] }

    for (let i = 0; i < 10; i++) {
      evictAncestryAndRegister(repo, ids, edgeData)
    }

    expect(ancestralCountForQuery(repo, edgeQuery)).toBe(1)
  })

  it("vertex no accumulation on re-registers", () => {
    const repo = new Repository()
    const vertexData = { type: "vertex", x: 0, y: 0, z: 0 }
    const ids = ["v1", "vertex", "@sk1"]

    for (let i = 0; i < 10; i++) {
      evictAncestryAndRegister(repo, ids, vertexData)
    }

    const vertexCounts: number[] = []
    for (const entry of repo.ancestral.values()) {
      for (const eid of entry.eids) {
        const payload = repo.elements.get(eid)
        if (payload != null && typeof payload === "object" && (payload as Record<string, unknown>).type === "vertex") {
          vertexCounts.push(entry.eids.length)
          break
        }
      }
    }
    expect(vertexCounts.length).toBeGreaterThan(0)
    for (const count of vertexCounts) {
      expect(count).toBe(1)
    }
  })

  it("edge replaced on changed geometry", () => {
    const repo = new Repository()
    const edgeQuery = "?2,4;e1line"
    const [ids] = parseAncestry(edgeQuery)

    evictAncestryAndRegister(repo, ids, { type: "straightedge", kind: "line", start: [0, 0, 0], end: [1, 0, 0] })
    evictAncestryAndRegister(repo, ids, { type: "straightedge", kind: "line", start: [0, 0, 0], end: [2, 0, 0] })

    const key = canonical(ids)
    const eids = repo.ancestral.get(key)?.eids ?? []
    expect(eids.length).toBe(1)

    const payload = repo.elements.get(eids[0]) as Record<string, unknown>
    expect(payload).toBeDefined()
    expect((payload.end as number[])[0]).toBeCloseTo(2)
  })

  it("clear removes all accumulated elements", () => {
    const repo = new Repository()
    const sketchId = "sk_test"

    for (let i = 0; i < 3; i++) {
      repo.registerAncestor(["ancestor_a", "ancestor_b"], { type: "straightedge", sketch_id: sketchId, idx: i })
    }

    const key = canonical(["ancestor_a", "ancestor_b"])
    expect(repo.ancestral.get(key)?.eids.length).toBe(3)

    clearFeatureGeometryRegistrations(repo, sketchId)

    const remaining: string[] = []
    for (const [eid, obj] of [...repo.elements]) {
      if (obj != null && typeof obj === "object" && (obj as Record<string, unknown>).sketch_id === sketchId) {
        remaining.push(eid)
      }
    }
    expect(remaining.length).toBe(0)
    expect(repo.ancestral.has(key)).toBe(false)
  })

  it("no ambiguous query after postRegister repeats", () => {
    const repo = initGlobalRepo()
    const topology = {
      surfaces: [],
      edges: [{ query: "?2,4;e1line", start: [0, 0], end: [1, 0], kind: "line" }],
      vertices: { v1: { x: 0, y: 0 } },
    }
    const feature = { id: "sk1", kind: "sketch", plane: "@builtin_plane_front", entities: [] }
    const featureResult = {
      status: "ok",
      geometry: {},
      plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] },
      topology,
    }

    for (let i = 0; i < 5; i++) {
      postRegister(repo, "sk1", feature, featureResult)
    }

    expect(() => repo.query("?2,4;e1line")).not.toThrow()
    const result = repo.query("?2,4;e1line")
    expect(result).not.toBeNull()
  })

  // Ancestry entry for removed feature is evicted by gc(active_fids=set()).
  it("gc removes stale entry", () => {
    const repo = new Repository()
    repo.registerAncestor(["@f1", "surf1"], { type: "flatface" })
    expect(repo.ancestral.size).toBe(1)

    repo.gc(new Set())

    expect(repo.ancestral.size).toBe(0)
    expect(repo.elements.size).toBe(0)
  })

  // Ancestry entry for active feature is kept by gc(active_fids={"f1"}).
  it("gc keeps active entry", () => {
    const repo = new Repository()
    const eid = repo.registerAncestor(["@f1", "surf1"], { type: "flatface" })
    expect(repo.ancestral.size).toBe(1)

    repo.gc(new Set(["f1"]))

    expect(repo.ancestral.size).toBe(1)
    expect(repo.elements.get(eid)).not.toBeNull()
  })

  // Entries without @-prefixed tags (built-ins) are not evicted.
  it("gc keeps builtin entries", () => {
    const repo = new Repository()
    repo.registerAncestor(["builtin_front", "builtin_plane"], { type: "plane" })

    repo.gc(new Set())

    expect(repo.ancestral.size).toBe(1)
  })

  // Only stale entries are removed; active entries survive.
  it("gc partial eviction", () => {
    const repo = new Repository()
    repo.registerAncestor(["@f1", "surf1"], { type: "flatface" })
    repo.registerAncestor(["@f2", "surf1"], { type: "flatface" })

    repo.gc(new Set(["f1"]))

    const remaining = [...repo.ancestral.keys()]
    expect(remaining.length).toBe(1)
    expect(repo.ancestral.has(canonical(["@f1", "surf1"]))).toBe(true)
  })
})

// ─── Plane/point type helpers ───

describe("isPlaneType", () => {
  it("accepts plane and face types", () => {
    expect(isPlaneType({ type: "plane" })).toBe(true)
    expect(isPlaneType({ type: "face" })).toBe(true)
    expect(isPlaneType({ type: "flatface" })).toBe(true)
  })

  it("rejects non-plane types", () => {
    expect(isPlaneType({ type: "vertex" })).toBe(false)
    expect(isPlaneType({ type: "edge" })).toBe(false)
    expect(isPlaneType({})).toBe(false)
  })
})

describe("isPointType", () => {
  it("accepts point and vertex types", () => {
    expect(isPointType({ type: "point" })).toBe(true)
    expect(isPointType({ type: "vertex" })).toBe(true)
  })

  it("rejects non-point types", () => {
    expect(isPointType({ type: "plane" })).toBe(false)
    expect(isPointType({ type: "face" })).toBe(false)
    expect(isPointType({})).toBe(false)
  })
})

describe("getPoint3d", () => {
  it("handles vertex type with origin", () => {
    const repo = new Repository()
    const vertex = { type: "vertex", origin: [1.0, 2.0, 3.0] }
    const result = getPoint3d(vertex, repo)
    expect(result[0]).toBeCloseTo(1.0)
    expect(result[1]).toBeCloseTo(2.0)
    expect(result[2]).toBeCloseTo(3.0)
  })

  it("handles origin without normal", () => {
    const repo = new Repository()
    const pt = { origin: [4.0, 5.0, 6.0] }
    const result = getPoint3d(pt, repo)
    expect(result[0]).toBeCloseTo(4.0)
    expect(result[1]).toBeCloseTo(5.0)
    expect(result[2]).toBeCloseTo(6.0)
  })

  it("rejects origin with normal (plane, not a point)", () => {
    const repo = new Repository()
    const planeLike = { origin: [0.0, 0.0, 0.0], normal: [0.0, 0.0, 1.0] }
    expect(() => getPoint3d(planeLike, repo)).toThrow("reference is a plane, not a point")
  })
})

describe("resolvePlaneEarly", () => {
  it("resolves face via $ prefix", () => {
    const repo = initGlobalRepo()
    const face = {
      type: "face",
      centroid: [0, 0, 0],
      normal: [0, 0, 1],
      origin: [0, 0, 0],
      x_axis: [1, 0, 0],
      y_axis: [0, 1, 0],
    }
    repo.register("f1", face)
    const result = resolvePlaneEarly("$f1", repo)
    expect(result).toBe(face)
  })

  it("rejects vertex via $ prefix (falls back to FRONT_PLANE)", () => {
    const repo = initGlobalRepo()
    const vertex = { type: "vertex", origin: [1.0, 2.0, 3.0] }
    repo.register("v1", vertex)
    const result = resolvePlaneEarly("$v1", repo)
    expect(isPlaneType(result)).toBe(true)
    // Should not return the vertex, falls back to FRONT_PLANE
    expect(result).not.toBe(vertex)
  })
})

// ─── B-rep vertex / face integration (requires OCC build pipeline, skipped in this suite) ───

describe("makeAncestryQuery construction details", () => {
  // Result starts with '?' and ends with ':face'.
  it("produces wire format with type restriction suffix", () => {
    const ids = ["@sketchA/lineX", "@sketchA/lineY"]
    const q = makeAncestryQuery(ids, "face")
    expect(q.startsWith("?")).toBe(true)
    expect(q.endsWith(":face")).toBe(true)
  })

  // Caller is responsible for sort order - different order → different string.
  it("preserves caller-determined sort order", () => {
    const q_ab = makeAncestryQuery(["@a", "@b"], "face")
    const q_ba = makeAncestryQuery(["@b", "@a"], "face")
    expect(q_ab).not.toBe(q_ba)
    const ids = ["@b", "@a"]
    const q_sorted = makeAncestryQuery([...ids].sort(), "face")
    const q_sorted2 = makeAncestryQuery([...ids].sort(), "face")
    expect(q_sorted).toBe(q_sorted2)
  })

  it("supports nested ancestry query strings", () => {
    const inner = makeAncestryQuery(["AAAAAAAAAAAA", "BBBBBBBBBBBB"])
    const outer = makeAncestryQuery([inner, "AAAAAAAAAAAA"])
    const [ids] = parseAncestry(outer)
    expect(ids[0]).toBe(inner)
    expect(ids[1]).toBe("AAAAAAAAAAAA")
  })
})

describe("parseAncestry edge cases", () => {
  // wire-format-hardening: unconsumed trailing data that is not a ":type" /
  // "@cls" suffix used to be dropped silently; it now fails loud (pinned in
  // queryWireHardening.test.ts). The old lenient behavior hid typos.
  it("rejects unconsumed trailing data beyond the parsed length", () => {
    expect(() => parseAncestry("?3;abcdef")).toThrow()
  })
})

/** Geometry simplification scenario: a query was built with ancestors {A, B, C}
 * (e.g. three concurrent lines), but after a geometry change the element is
 * re-registered with only {A, B}. The old query must still resolve because
 * {A, B} ⊆ {A, B, C}.
 *
 * If a query matches more than one element, it is ambiguous and must raise. */
describe("query ambiguity, partial resolve", () => {
  /** Two elements share ancestor A; query with {A, B} finds both via
   *  partial match (one exact, one subset of larger set) -> ambiguous. */
  it("partial match ambiguous when query matches multiple entries", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B"], { type: "pt", x: 1.0, y: 0.0 })
    repo.registerAncestor(["@A", "@B", "@C"], { type: "pt", x: -1.0, y: 0.0 })
    const q = makeAncestryQuery(["@A", "@B"])
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  // Partial resolve becomes unambiguous when type narrows it to one.
  it("ambiguous partial match disambiguated by type restriction", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B"], { type: "pt" })
    repo.registerAncestor(["@A", "@C"], { type: "line" })
    const q = makeAncestryQuery(["@A", "@B"], "pt")
    expect(repo.query(q)).not.toBeNull()
  })
})

describe("parseQuery validation", () => {
  it("rejects absolute format with too many path parts", () => {
    expect(() => parseQuery("@a/b/c/d")).toThrow("Unrecognized absolute query")
  })
})

describe("empty query handling", () => {
  it("empty string query returns null", () => {
    const repo = new Repository()
    expect(repo.query("")).toBeNull()
  })
})

describe("typed query object dispatch", () => {
  it("repo.query accepts LocalQuery via local() helper", () => {
    const repo = new Repository()
    const obj = { v: 1 }
    repo.register("AAAAAAAAAAAAAAAAAA/e1", obj)
    expect(repo.query(local("e1"), "AAAAAAAAAAAAAAAAAA/")).toBe(obj)
  })

  it("repo.query accepts AbsoluteQuery via absolute() helper", () => {
    const repo = new Repository()
    const obj = { v: 2 }
    repo.register("AAAAAAAAAAAAAAAAAA/BBBBBBBBBBBB", obj)
    expect(repo.query(absolute("AAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBB"))).toBe(obj)
  })

  it("repo.query accepts AncestryQuery via ancestry() helper", () => {
    const repo = new Repository()
    const obj = { type: "pt" }
    const ids = ["@a", "@b"]
    repo.registerAncestor(ids, obj)
    const aq = ancestry(ids, "pt")
    expect(repo.query(aq)).toBe(obj)
  })
})

describe("B-rep vertex and face integration", () => {
  it.skip("vertex registered in repo after build", () => {
    // Requires build() with OCC.js, covered by builder.test.ts
  })

  it.skip("three point plane from brep vertices", () => {
    // Requires build() with OCC.js + three_point plane mode
  })

  it.skip("plane point mode with brep vertex", () => {
    // Requires build() with OCC.js + plane_point mode
  })

  it.skip("plane on face mode from brep face", () => {
    // Requires build() with OCC.js + on_face plane mode
  })
})

// ─── HeuristicConfig / scoreOverlap / pickBest ───

describe("HeuristicConfig defaults", () => {
  // DEFAULT_HEURISTIC_CONFIG has sensible defaults.
  it("defaults are sensible", () => {
    const cfg = DEFAULT_HEURISTIC_CONFIG
    expect(cfg.overlapThreshold).toBe(0.5)
    expect(cfg.ambiguityMargin).toBe(0.0)
    expect(cfg.geometryLeafTolerance).toBe(0.01)
    expect(cfg.kindWeights).toEqual({})
    expect(weightFor(cfg, "any")).toBe(1.0)
    expect(weightFor(cfg, "edge")).toBe(1.0)
  })
})

describe("scoreOverlap", () => {
  // score_overlap handles empty sets and perfect matches.
  it("edge cases and exact matches", () => {
    expect(scoreOverlap(new Set(), new Set())).toBe(0.0)
    expect(scoreOverlap(new Set(["a"]), new Set())).toBe(0.0)
    expect(scoreOverlap(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1.0)
    expect(scoreOverlap(new Set(["a", "b"]), new Set(["b", "c"]))).toBe(0.5)
    expect(scoreOverlap(new Set(["a", "b", "c"]), new Set(["a"]))).toBeCloseTo(1.0 / 3.0)
  })
})

describe("pickBest", () => {
  // pick_best with one candidate returns RESOLVED.
  it("single candidate returns RESOLVED", () => {
    const cfg = DEFAULT_HEURISTIC_CONFIG
    const [outcome, winner] = pickBest([["item", 0.8]], cfg)
    expect(outcome).toBe(Outcome.RESOLVED)
    expect(winner).toBe("item")
  })

  // pick_best with one candidate beating another by > margin.
  it("clear winner beats runner-up by > margin", () => {
    const cfg: HeuristicConfig = { ...DEFAULT_HEURISTIC_CONFIG, ambiguityMargin: 0.2 }
    const [outcome, winner] = pickBest(
      [["A", 0.9], ["B", 0.5]],
      cfg,
    )
    expect(outcome).toBe(Outcome.RESOLVED)
    expect(winner).toBe("A")
  })

  // pick_best with scores within margin returns AMBIGUOUS.
  it("ambiguous within margin", () => {
    const cfg: HeuristicConfig = { ...DEFAULT_HEURISTIC_CONFIG, ambiguityMargin: 0.3 }
    const [outcome, winner] = pickBest(
      [["A", 0.8], ["B", 0.7]],
      cfg,
    )
    expect(outcome).toBe(Outcome.AMBIGUOUS)
    expect(winner).toBeNull()
  })

  // pick_best with no candidates returns UNRESOLVED.
  it("empty returns UNRESOLVED", () => {
    const [outcome, winner] = pickBest([], DEFAULT_HEURISTIC_CONFIG)
    expect(outcome).toBe(Outcome.UNRESOLVED)
    expect(winner).toBeNull()
  })
})

describe("scoreGeometryLeaf", () => {
  const cfg = DEFAULT_HEURISTIC_CONFIG

  // A null hint on either side is treated as a non-penalty (perfect score).
  it("null hints incur no penalty", () => {
    expect(scoreGeometryLeaf(null, { x: 1 }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: 1 }, null, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf(null, null, cfg)).toBe(1.0)
  })

  // With no keys shared between the hints there is nothing to agree on.
  it("no shared keys scores zero", () => {
    expect(scoreGeometryLeaf({ x: 1 }, { y: 2 }, cfg)).toBe(0.0)
    expect(scoreGeometryLeaf({}, {}, cfg)).toBe(0.0)
  })

  // Numbers within the relative tolerance count as a match, beyond it do not.
  it("numeric comparison honours the relative tolerance", () => {
    // 0.5 / 100 = 0.005 <= 0.01 default tolerance.
    expect(scoreGeometryLeaf({ r: 100 }, { r: 100.5 }, cfg)).toBe(1.0)
    // 2 / 100 = 0.02 > 0.01.
    expect(scoreGeometryLeaf({ r: 100 }, { r: 102 }, cfg)).toBe(0.0)
  })

  // Two near-zero magnitudes are equal regardless of relative difference.
  it("treats both-near-zero values as matching", () => {
    expect(scoreGeometryLeaf({ x: 0 }, { x: 0 }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: 1e-13 }, { x: -1e-13 }, cfg)).toBe(1.0)
  })

  // Non-numeric values fall back to strict equality.
  it("non-numeric values compare by equality", () => {
    expect(scoreGeometryLeaf({ kind: "arc" }, { kind: "arc" }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ kind: "arc" }, { kind: "line" }, cfg)).toBe(0.0)
  })

  // Null/undefined leaf values match only when both sides are absent.
  it("null and undefined leaf values match only when both absent", () => {
    expect(scoreGeometryLeaf({ x: null }, { x: null }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: undefined }, { x: undefined }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: null }, { x: 5 }, cfg)).toBe(0.0)
  })

  // Score is the fraction of shared keys that agree; absent keys are ignored.
  it("scores the fraction of agreeing shared keys", () => {
    // x agrees (numeric), y disagrees, z is not shared and ignored.
    expect(scoreGeometryLeaf({ x: 1, y: 2, z: 9 }, { x: 1, y: 3 }, cfg)).toBe(0.5)
  })

  // A tighter tolerance from config rejects a difference a looser one accepts.
  it("respects a custom geometryLeafTolerance", () => {
    const strict: HeuristicConfig = { ...cfg, geometryLeafTolerance: 0.001 }
    expect(scoreGeometryLeaf({ r: 100 }, { r: 100.5 }, strict)).toBe(0.0)
    expect(scoreGeometryLeaf({ r: 100 }, { r: 100.5 }, cfg)).toBe(1.0)
  })
})

// ─── queryAll ───

/** Tests for the ancestry hierarchy: solid, extrusion-feature, sketch-feature queries.
 *
 * Key invariants:
 * - Leaf entities carry the feature root in their ancestor set.
 * - query() with a full ancestor set finds the exact entity.
 * - query_all() with just the feature root enumerates all entities of a given type. */
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

// ─── queryAllTyped ───

describe("queryAllTyped", () => {
  it("uuid-only typed query returns that uuid's elements only", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "u_ele" }, "u_aaa")
    repo.registerAncestor(["@feat2"], { type: "straightedge", tag: "other" })
    const results = repo.queryAllTyped(
      ancestry([constructionUuidToken("u_aaa")]),
    ) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("u_ele")
  })

  it("classifier-only typed query returns []", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", classifiers: ["cls_zp"] })
    expect(repo.queryAllTyped(ancestry(["@cls_zp"]))).toEqual([])
  })

  it("type restriction matches subtypes", () => {
    const repo = new Repository()
    repo.registerAncestor(["@feat1"], { type: "flatface", tag: "ff" })
    const results = repo.queryAllTyped(ancestry(["@feat1"], "face")) as Record<string, unknown>[]
    expect(results.length).toBe(1)
    expect(results[0].tag).toBe("ff")
  })
})

// ─── Descriptor tier (query-descriptor-identity) ───

describe("descriptor tier resolution", () => {
  const cap = (z: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "flatface",
    body_id: "body1",
    created_by: "ex1",
    centroid: [0, 0, z],
    normal: [0, 0, 1],
    ...extra,
  })

  /** The headline fix: a dimension edit moved the picked face; the persisted
   *  descriptor still finds it among ancestry siblings by nearest-with-margin,
   *  where the old digest token would have gone stale. */
  it("resolves a moved face among ancestry siblings", () => {
    const repo = new Repository()
    // Two caps of one extrude: the picked +z cap moved from z=10 to z=14.
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0, { normal: [0, 0, -1] }))
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(14))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 14])
  })

  it("signed normal gate never matches the anti-parallel cap", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0, { normal: [0, 0, -1] }))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    // Only candidate fails the gate -> graceful passthrough leaves 1 candidate,
    // which resolves (same as today's single-candidate behaviour), so instead
    // register a second aligned face and assert the gate picks it.
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(20))
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 20])
  })

  it("a near-tie stays ambiguous and fails loud", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(11))
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(11.5))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("tight window beats nearest: numeric jitter resolves exactly", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(10.0002))
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(10.4))
    const q = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 10.0002])
  })

  it("descriptor tokens do not poison the ancestry subset match", () => {
    const repo = new Repository()
    // Registered WITHOUT any descriptor in the key set; a query carrying a
    // descriptor must still full-subset match on its non-descriptor tokens.
    repo.registerAncestor(["@ex1", "@body1"], cap(5))
    const q = makeAncestryQuery(["@gdf|0,0,5|0,0,1", "@ex1", "@body1"])
    expect(repo.query(q)).not.toBeNull()
  })

  it("mixed garbage descriptor + UUID: UUID tier still resolves", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0), "u_old0")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(10), "u_old1")
    // Descriptor is unparseable garbage (never narrows); the UUID
    // still disambiguates by construction identity.
    const q = makeAncestryQuery(["@gdf|garbage", constructionUuidToken("u_old1"), "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 10])
  })

  it("global fallback without ancestry is tight-only", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(10))
    // Exact position: resolves globally (analogue of the precise-hash rule).
    const qTight = makeAncestryQuery(["@gdf|0,0,10|0,0,1", "@X", "@Y"], "flatface")
    expect(repo.query(qTight)).not.toBeNull()
    // Moved position: must NOT loose-match across lineages -> null.
    const qLoose = makeAncestryQuery(["@gdf|0,0,13|0,0,1", "@X", "@Y"], "flatface")
    expect(repo.query(qLoose)).toBeNull()
  })

  it("edge descriptors tie-break edge siblings", () => {
    const repo = new Repository()
    const edge = (y: number): Record<string, unknown> => ({
      type: "straightedge",
      body_id: "body1",
      created_by: "ex1",
      kind: "line",
      start: [0, y, 0],
      end: [10, y, 0],
    })
    repo.registerAncestor(["@body1/edge0", "@ex1", "@body1"], edge(0))
    repo.registerAncestor(["@body1/edge1", "@ex1", "@body1"], edge(20))
    const q = makeAncestryQuery(
      [
        "@gde|line|5,21,0|1,0,0|10",
        "@ex1",
        "@body1",
      ],
      "straightedge",
    )
    const result = repo.query(q)
    expect((result as Record<string, unknown>).start).toEqual([0, 20, 0])
  })

  it("queryAll ignores descriptor tokens in the subset match", () => {
    const repo = new Repository()
    repo.registerAncestor(["@ex1", "@body1"], cap(5))
    const q = makeAncestryQuery(["@gdf|9,9,9|0,0,1", "@ex1"])
    expect(repo.queryAll(q).length).toBe(1)
  })
})
