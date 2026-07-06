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
} from "./query"
import type { AncestryQuery } from "./query"
import { emitFaceDescriptor, emitEdgeDescriptor } from "./geomDescriptor"
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
      repo.registerAncestor(op.ancestors as string[], op.obj, (op.geom_hash as string) ?? null)
      break
    case "evict_register":
      evictAncestryAndRegister(
        repo,
        op.ancestors as string[],
        op.obj as Record<string, unknown>,
        (op.index_tag as string) ?? null,
        (op.geom_hash as string) ?? null,
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
    // alpha char before suffix means it is part of the eid, not a subpoint
    expect(parseQuery("$mystart")).toEqual(local("mystart"))
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

  it("makeAncestryQuery keeps empty type restriction; emitWire drops it", () => {
    expect(makeAncestryQuery(["@a"], "")).toBe("?2;@a:")
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
    expect(bodyIdOf(wire)).toBe("body_ex1edge0")
    expect(bodyIdOf("?1;@a")).toBeNull()
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

  it("returns null when body_store missing for upward coercion", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@ex1"],
      { type: "flatface", body_id: "body_ex1", face_index: 0, created_by: "ex1" },
    )
    const q = makeAncestryQuery(["@ex1"], "solid")
    const result = repo.query(q)
    expect(result).toBeNull()
  })

  it("coerces face to edge (sibling coercion)", () => {
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

  /** Two candidates coercing to different solids is ambiguous -> fail loud. */
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

  /** Several faces of one body coerce to the same solid -> resolve cleanly. */
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
 * 1. Full ancestral — query_set <= registered_key
 * 2. Partial ancestral — registered_key <= query_set (reverse direction, unique only)
 * 3. Geometry hash fallback */
describe("partial ancestral resolver (tier 2)", () => {
  /** Query carries an extra ancestor not in registration; tier 2 resolves it. */
  it("resolves when unique — extra ancestor in query not in registration", () => {
    // Registered under {A, B} but the query has {A, B, extra}
    const repo = new Repository()
    const payload = { type: "face", body_id: "body1", created_by: "ex1" }
    repo.registerAncestor(["@A", "@B"], payload, "gface_hash1")
    const result = repo.query(makeAncestryQuery(["@A", "@B", "@extra"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")
  })

  /** Two elements share no common registered superset but both match tier 2. */
  it("ambiguous yields no match — two entries both match tier 2 but >1 candidate", () => {
    // Query has both @A and @B — tier 1 finds nothing (query not subset of any key),
    // tier 2 finds both (@A <= query_set and @B <= query_set) — returns nothing
    const repo = new Repository()
    repo.registerAncestor(["@A"], { type: "face", body_id: "body1", created_by: "ex1" }, "gface_a")
    repo.registerAncestor(["@B"], { type: "face", body_id: "body2", created_by: "ex2" }, "gface_b")
    const result = repo.query(makeAncestryQuery(["@A", "@B"]))
    expect(result).toBeNull()
  })

  /** No subset relation either way — tier 2 finds nothing, falls to tier 3 (hash). */
  it("falls to hash when ancestors are disjoint — no subset relation either way", () => {
    // Query with completely different ancestors — @X, @Y have no subset relation
    // with @A, @B, @C. Tier 1+2 miss. Hash fallback resolves via @gface_hash1.
    const repo = new Repository()
    repo.registerAncestor(
      ["@A", "@B", "@C"],
      { type: "face", body_id: "body1", created_by: "ex1" },
      "gface_hash1",
    )
    const result = repo.query(makeAncestryQuery(["@gface_hash1", "@X", "@Y"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")
  })

  /** Tier 1 exact-match candidate is returned without scanning tier 2. */
  it("full match wins over partial — tier 1 exact superset returned without scanning tier 2", () => {
    // @A, @B is a subset that would match tier 2, but the full @A,@B,@C match wins
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B", "@C"], { type: "face", body_id: "body1", created_by: "full" })
    repo.registerAncestor(["@A", "@B"], { type: "face", body_id: "body2", created_by: "partial" })
    const result = repo.query(makeAncestryQuery(["@A", "@B", "@C"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("full")
  })

  /** Tier 2 respects type_restriction. */
  it("respects type restriction in tier 2", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@A", "@B"],
      { type: "face", body_id: "body1", created_by: "ex1" },
      "gface_h1",
    )
    const result = repo.query(makeAncestryQuery(["@gface_h1", "@A", "@B", "@extra"], "face"))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")

    const resultWrong = repo.query(makeAncestryQuery(["@gface_h1", "@A", "@B", "@extra"], "edge"))
    expect(resultWrong).toBeNull()
  })

  /** Verify that existing tier 1 behaviour (query <= key) is undisturbed. */
  it("tier 1 subset still resolves — query with fewer ancestors than registered key", () => {
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

/** Tests for two-tier ancestry resolution: ancestral primary, geom_hash fallback. */
describe("geom-hash fallback (two-tier ancestry resolution)", () => {
  it("isGeomHashId detects prefixes", () => {
    expect(isGeomHashId("@gface_abc123")).toBe(true)
    expect(isGeomHashId("@gedge_abc123")).toBe(true)
    expect(isGeomHashId("@gvertex_abc123")).toBe(true)
    expect(isGeomHashId("@ex1")).toBe(false)
    expect(isGeomHashId("@body_ex1")).toBe(false)
    expect(isGeomHashId("@body_ex1/face0")).toBe(false)
  })

  /** Hash in by_geom_hash does not affect pure-ancestry queries. */
  it("hash in byGeomHash does not affect pure-ancestry queries", () => {
    const repo = new Repository()
    const payload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "gface_abc")

    const result = repo.query(makeAncestryQuery(["@ex1"]))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["created_by"]).toBe("ex1")
  })

  /** After registering with geom_hash, no frozenset in ancestral contains a geom_hash string. */
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

  /** register_ancestor with geom_hash populates by_geom_hash. */
  it("registerAncestor with geomHash populates byGeomHash", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/face0", "@ex1", "@body1"],
      makeFacePayload("body1", "ex1", 0),
      "gface_abc",
    )

    expect(repo.byGeomHash.has("gface_abc")).toBe(true)
    expect(repo.byGeomHash.get("gface_abc")!.length).toBe(1)
  })

  /** When ancestral query finds nothing, by_geom_hash is consulted as last resort. */
  it("hash fallback when ancestral query finds nothing", () => {
    const repo = new Repository()
    const payload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "gface_hash1")

    const result = repo.query(makeAncestryQuery(["@gface_hash1"]))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["created_by"]).toBe("ex1")
  })

  /** Hash fallback respects type_restriction. */
  it("hash fallback respects type restriction", () => {
    const repo = new Repository()
    const facePayload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], facePayload, "gface_hash1")

    const result = repo.query(makeAncestryQuery(["@gface_hash1"], "flatface"))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["type"]).toBe("flatface")

    const wrongType = repo.query(makeAncestryQuery(["@gface_hash1"], "edge"))
    expect(wrongType).toBeNull()
  })

  /** Two faces share structural ancestry but differ by hash; hash narrows the result. */
  it("hash disambiguates when shared structural ancestry is ambiguous", () => {
    const repo = new Repository()
    const payloadA = makeFacePayload("body1", "ex1", 0)
    const payloadB = makeFacePayload("body1", "ex1", 1)

    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payloadA, "gface_aaa")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], payloadB, "gface_bbb")

    expect(() => repo.query(makeAncestryQuery(["@ex1"]))).toThrow(AmbiguousQueryError)

    const resultA = repo.query(makeAncestryQuery(["@gface_aaa", "@ex1", "@body1"]))
    expect(resultA).not.toBeNull()
    expect((resultA as Payload)["face_index"]).toBe(0)

    const resultB = repo.query(makeAncestryQuery(["@gface_bbb", "@ex1", "@body1"]))
    expect(resultB).not.toBeNull()
    expect((resultB as Payload)["face_index"]).toBe(1)
  })

  /** Edge hashes populate byGeomHash, not ancestral keys. */
  it("edge geom hash populates byGeomHash not ancestral", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/edge0", "@ex1", "@body1"],
      { type: "straightedge", body_id: "body1", created_by: "ex1", edge_index: 0 },
      "gedge_xyz",
    )

    expect(repo.byGeomHash.has("gedge_xyz")).toBe(true)
    expect(repo.byGeomHash.get("gedge_xyz")!.length).toBe(1)

    for (const entry of repo.ancestral.values()) {
      for (const tag of entry.set) {
        expect(isGeomHashId(tag)).toBe(false)
      }
    }
  })

  /** Vertex hashes populate byGeomHash, not ancestral keys. */
  it("vertex geom hash populates byGeomHash not ancestral", () => {
    const repo = new Repository()
    repo.registerAncestor(
      ["@body1/vertex0", "@ex1", "@body1"],
      { type: "vertex", body_id: "body1", created_by: "ex1", vertex_index: 0 },
      "gvertex_def",
    )

    expect(repo.byGeomHash.has("gvertex_def")).toBe(true)
    expect(repo.byGeomHash.get("gvertex_def")!.length).toBe(1)

    for (const entry of repo.ancestral.values()) {
      for (const tag of entry.set) {
        expect(isGeomHashId(tag)).toBe(false)
      }
    }
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

    // Filter to face registrations — keys whose set contains a /face positional tag
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
   *  This is a structural invariant: hashes live in byGeomHash only. */
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

    expect(repo.byGeomHash.has("gface_abc")).toBe(true)
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
  it("contradictory classifiers do not zero a hash-resolvable query", () => {
    const repo = new Repository()
    const payloadP = { ...makeFacePayload("body1", "ex1", 0), classifiers: ["cls_zp"] }
    const payloadN = { ...makeFacePayload("body1", "ex1", 1), classifiers: ["cls_zn"] }
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payloadP, "gface_aaa")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], payloadN, "gface_bbb")

    // @cls_zp resolves the +Z cap via ancestry + classifier + hash.
    const r1 = repo.query(makeAncestryQuery(["@gface_aaa", "@cls_zp", "@ex1", "@body1"]))
    expect(r1).not.toBeNull()
    expect((r1 as Payload).classifiers).toEqual(["cls_zp"])

    // Add the OPPOSITE-sign classifier: no face matches both clauses, so
    // the classifier tier narrows to nothing.  The hash still resolves.
    const contradictory = makeAncestryQuery(["@gface_aaa", "@cls_zp", "@cls_zn", "@ex1", "@body1"])
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

  /** Test that adding surface indices to ancestor IDs disambiguates queries. */
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

  /** Test that indexed queries resolve to a single surface, not both. */
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

  function repoWithFlatface(ancestors: string[], geomHash?: string): Repository {
    const repo = new Repository()
    repo.registerAncestor(ancestors, flatfaceObj, geomHash ?? null)
    return repo
  }

  /** Baseline: an exact-tier flatface coerces up to its solid. */
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

  /** Contrast: the same partial match resolves fine when no type is demanded. */
  it("partial tier resolves without type restriction", () => {
    const repo = repoWithFlatface(["@A"])
    const q = makeAncestryQuery(["@A", "@extra"])
    const result = repo.query(q, null, bodyStoreWithSolid)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).type).toBe("flatface")
  })

  /** A face reached only via the no-ancestry hash fallback does NOT coerce. */
  it("coercion skipped in hash fallback tier (no ancestry = strict type filter)", () => {
    const repo = repoWithFlatface(["@A"], "gface_h")
    // @X shares no subset relation with @A (tiers 1+2 miss); only the precise
    // hash matches. With type_restriction=solid the strict filter drops it.
    const q = makeAncestryQuery(["@gface_h", "@X"], "solid")
    expect(repo.query(q, null, bodyStoreWithSolid)).toBeNull()
  })

  /** Contrast: the hash fallback resolves the face when no type is demanded. */
  it("hash fallback resolves without type restriction", () => {
    const repo = repoWithFlatface(["@A"], "gface_h")
    const q = makeAncestryQuery(["@gface_h", "@X"])
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
    geomHash?: string,
    type = "face",
  ): string {
    return repo.registerAncestor(ancestors, { type, created_by: owner }, geomHash ?? null)
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

  it("hash fallback rejects forward match", () => {
    // Identical geom hash, distinct ancestry; query carries only the hash so
    // resolution lands in the tier-3 hash fallback.
    const repo = new Repository()
    repo.setFeatureOrder(["f0", "f1"])
    reg(repo, ["@f0"], "f0", "gface_X")
    reg(repo, ["@f1"], "f1", "gface_X")
    const q = ancestry(["@gface_X"])

    const resolved = repo.query(q, null, null, "f0") as Record<string, unknown>
    expect(resolved).not.toBeNull()
    expect(resolved.created_by).toBe("f0")
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

/** The orchestration prunes ancestral + elements together, leaving no
 * dangling eid: every eid listed in any ancestral list still exists in elements. */
describe("clearFeatureGeometryRegistrations", () => {
  /** The orchestration prunes ancestral + elements together: no dangling eid. */
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
  const byGeomHash: Record<string, string[]> = {}
  for (const [k, v] of repo.byGeomHash) byGeomHash[k] = [...v]
  return { elements, ancestral, byGeomHash }
}

/** Tests for repo snapshot shallow copy memory and correctness. */
describe("repoFromSnapshot", () => {
  /** _repo_from_snapshot with shallow copy produces same query results. */
  it("preserves correctness with payloads", () => {
    const original = buildRepoWithPayloads(100)
    const snapshot = makeSnapshot(original)

    const repo = repoFromSnapshot(snapshot)

    for (const [eid, val] of original.elements) {
      expect(repo.elements.get(eid)).toEqual(val)
    }
    expect(new Set(repo.ancestral.keys())).toEqual(new Set(original.ancestral.keys()))
  })

  /** dict() copy uses less memory than deepcopy for the same payloads —
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

  /** Appending to an ancestral list in deserialized repo does not affect snapshot. */
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

  /** Empty snapshot produces empty repo. */
  it("handles empty snapshot", () => {
    const repo = repoFromSnapshot({ elements: {}, ancestral: {}, byGeomHash: {} })
    expect(repo.elements.size).toBe(0)
    expect(repo.ancestral.size).toBe(0)
  })

  /** Old-format snapshot (no elements/ancestral keys) returns empty repo. */
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

  /** Ancestry entry for removed feature is evicted by gc(active_fids=set()). */
  it("gc removes stale entry", () => {
    const repo = new Repository()
    repo.registerAncestor(["@f1", "surf1"], { type: "flatface" })
    expect(repo.ancestral.size).toBe(1)

    repo.gc(new Set())

    expect(repo.ancestral.size).toBe(0)
    expect(repo.elements.size).toBe(0)
  })

  /** Ancestry entry for active feature is kept by gc(active_fids={"f1"}). */
  it("gc keeps active entry", () => {
    const repo = new Repository()
    const eid = repo.registerAncestor(["@f1", "surf1"], { type: "flatface" })
    expect(repo.ancestral.size).toBe(1)

    repo.gc(new Set(["f1"]))

    expect(repo.ancestral.size).toBe(1)
    expect(repo.elements.get(eid)).not.toBeNull()
  })

  /** Entries without @-prefixed tags (built-ins) are not evicted. */
  it("gc keeps builtin entries", () => {
    const repo = new Repository()
    repo.registerAncestor(["builtin_front", "builtin_plane"], { type: "plane" })

    repo.gc(new Set())

    expect(repo.ancestral.size).toBe(1)
  })

  /** Only stale entries are removed; active entries survive. */
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
    // Should not return the vertex — falls back to FRONT_PLANE
    expect(result).not.toBe(vertex)
  })
})

// ─── B-rep vertex / face integration (requires OCC build pipeline — skipped in this suite) ───

describe("makeAncestryQuery construction details", () => {
  /** Result starts with '?' and ends with ':face'. */
  it("produces wire format with type restriction suffix", () => {
    const ids = ["@sketchA/lineX", "@sketchA/lineY"]
    const q = makeAncestryQuery(ids, "face")
    expect(q.startsWith("?")).toBe(true)
    expect(q.endsWith(":face")).toBe(true)
  })

  /** Caller is responsible for sort order - different order → different string. */
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
  it("ignores extra characters beyond parsed length", () => {
    const [ids, typ] = parseAncestry("?3;abcdef")
    expect(ids).toEqual(["abc"])
    expect(typ).toBeNull()
  })
})

/** Geometry simplification scenario: a query was built with ancestors {A, B, C}
 * (e.g. three concurrent lines), but after a geometry change the element is
 * re-registered with only {A, B}. The old query must still resolve because
 * {A, B} ⊆ {A, B, C}.
 *
 * If a query matches more than one element, it is ambiguous and must raise. */
describe("query ambiguity — partial resolve", () => {
  /** Two elements share ancestor A; query with {A, B} finds both via
   *  partial match (one exact, one subset of larger set) -> ambiguous. */
  it("partial match ambiguous when query matches multiple entries", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B"], { type: "pt", x: 1.0, y: 0.0 })
    repo.registerAncestor(["@A", "@B", "@C"], { type: "pt", x: -1.0, y: 0.0 })
    const q = makeAncestryQuery(["@A", "@B"])
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  /** Partial resolve becomes unambiguous when type narrows it to one. */
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
    repo.register("AAAAAAAAAAAAAAAAAAe1", obj)
    expect(repo.query(local("e1"), "AAAAAAAAAAAAAAAAAA")).toBe(obj)
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
    // Requires build() with OCC.js — covered by builder.test.ts
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
  /** DEFAULT_HEURISTIC_CONFIG has sensible defaults. */
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
  /** score_overlap handles empty sets and perfect matches. */
  it("edge cases and exact matches", () => {
    expect(scoreOverlap(new Set(), new Set())).toBe(0.0)
    expect(scoreOverlap(new Set(["a"]), new Set())).toBe(0.0)
    expect(scoreOverlap(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1.0)
    expect(scoreOverlap(new Set(["a", "b"]), new Set(["b", "c"]))).toBe(0.5)
    expect(scoreOverlap(new Set(["a", "b", "c"]), new Set(["a"]))).toBeCloseTo(1.0 / 3.0)
  })
})

describe("pickBest", () => {
  /** pick_best with one candidate returns RESOLVED. */
  it("single candidate returns RESOLVED", () => {
    const cfg = DEFAULT_HEURISTIC_CONFIG
    const [outcome, winner] = pickBest([["item", 0.8]], cfg)
    expect(outcome).toBe(Outcome.RESOLVED)
    expect(winner).toBe("item")
  })

  /** pick_best with one candidate beating another by > margin. */
  it("clear winner beats runner-up by > margin", () => {
    const cfg: HeuristicConfig = { ...DEFAULT_HEURISTIC_CONFIG, ambiguityMargin: 0.2 }
    const [outcome, winner] = pickBest(
      [["A", 0.9], ["B", 0.5]],
      cfg,
    )
    expect(outcome).toBe(Outcome.RESOLVED)
    expect(winner).toBe("A")
  })

  /** pick_best with scores within margin returns AMBIGUOUS. */
  it("ambiguous within margin", () => {
    const cfg: HeuristicConfig = { ...DEFAULT_HEURISTIC_CONFIG, ambiguityMargin: 0.3 }
    const [outcome, winner] = pickBest(
      [["A", 0.8], ["B", 0.7]],
      cfg,
    )
    expect(outcome).toBe(Outcome.AMBIGUOUS)
    expect(winner).toBeNull()
  })

  /** pick_best with no candidates returns UNRESOLVED. */
  it("empty returns UNRESOLVED", () => {
    const [outcome, winner] = pickBest([], DEFAULT_HEURISTIC_CONFIG)
    expect(outcome).toBe(Outcome.UNRESOLVED)
    expect(winner).toBeNull()
  })
})

describe("scoreGeometryLeaf", () => {
  const cfg = DEFAULT_HEURISTIC_CONFIG

  /** A null hint on either side is treated as a non-penalty (perfect score). */
  it("null hints incur no penalty", () => {
    expect(scoreGeometryLeaf(null, { x: 1 }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: 1 }, null, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf(null, null, cfg)).toBe(1.0)
  })

  /** With no keys shared between the hints there is nothing to agree on. */
  it("no shared keys scores zero", () => {
    expect(scoreGeometryLeaf({ x: 1 }, { y: 2 }, cfg)).toBe(0.0)
    expect(scoreGeometryLeaf({}, {}, cfg)).toBe(0.0)
  })

  /** Numbers within the relative tolerance count as a match, beyond it do not. */
  it("numeric comparison honours the relative tolerance", () => {
    // 0.5 / 100 = 0.005 <= 0.01 default tolerance.
    expect(scoreGeometryLeaf({ r: 100 }, { r: 100.5 }, cfg)).toBe(1.0)
    // 2 / 100 = 0.02 > 0.01.
    expect(scoreGeometryLeaf({ r: 100 }, { r: 102 }, cfg)).toBe(0.0)
  })

  /** Two near-zero magnitudes are equal regardless of relative difference. */
  it("treats both-near-zero values as matching", () => {
    expect(scoreGeometryLeaf({ x: 0 }, { x: 0 }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: 1e-13 }, { x: -1e-13 }, cfg)).toBe(1.0)
  })

  /** Non-numeric values fall back to strict equality. */
  it("non-numeric values compare by equality", () => {
    expect(scoreGeometryLeaf({ kind: "arc" }, { kind: "arc" }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ kind: "arc" }, { kind: "line" }, cfg)).toBe(0.0)
  })

  /** Null/undefined leaf values match only when both sides are absent. */
  it("null and undefined leaf values match only when both absent", () => {
    expect(scoreGeometryLeaf({ x: null }, { x: null }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: undefined }, { x: undefined }, cfg)).toBe(1.0)
    expect(scoreGeometryLeaf({ x: null }, { x: 5 }, cfg)).toBe(0.0)
  })

  /** Score is the fraction of shared keys that agree; absent keys are ignored. */
  it("scores the fraction of agreeing shared keys", () => {
    // x agrees (numeric), y disagrees, z is not shared and ignored.
    expect(scoreGeometryLeaf({ x: 1, y: 2, z: 9 }, { x: 1, y: 3 }, cfg)).toBe(0.5)
  })

  /** A tighter tolerance from config rejects a difference a looser one accepts. */
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

  /** Existing exact queries must still resolve after the feature root is added. */
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
    const q = makeAncestryQuery([emitFaceDescriptor([0, 0, 10], [0, 0, 1]), "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 14])
  })

  it("signed normal gate never matches the anti-parallel cap", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0, { normal: [0, 0, -1] }))
    const q = makeAncestryQuery([emitFaceDescriptor([0, 0, 10], [0, 0, 1]), "@ex1", "@body1"], "flatface")
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
    const q = makeAncestryQuery([emitFaceDescriptor([0, 0, 10], [0, 0, 1]), "@ex1", "@body1"], "flatface")
    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("tight window beats nearest: numeric jitter resolves exactly", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(10.0002))
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(10.4))
    const q = makeAncestryQuery([emitFaceDescriptor([0, 0, 10], [0, 0, 1]), "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 10.0002])
  })

  it("descriptor tokens do not poison the ancestry subset match", () => {
    const repo = new Repository()
    // Registered WITHOUT any descriptor in the key set; a query carrying a
    // descriptor must still full-subset match on its non-descriptor tokens.
    repo.registerAncestor(["@ex1", "@body1"], cap(5))
    const q = makeAncestryQuery([emitFaceDescriptor([0, 0, 5], [0, 0, 1]), "@ex1", "@body1"])
    expect(repo.query(q)).not.toBeNull()
  })

  it("mixed legacy digest + descriptor tokens: digest tier still works after the descriptor tier", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(0), "gface_old0")
    repo.registerAncestor(["@body1/face1", "@ex1", "@body1"], cap(10), "gface_old1")
    // Descriptor is unparseable garbage (never narrows); the legacy digest
    // must still tie-break exactly as pre-descriptor docs did.
    const q = makeAncestryQuery(["@gdf|garbage", "@gface_old1", "@ex1", "@body1"], "flatface")
    const result = repo.query(q)
    expect((result as Record<string, unknown>).centroid).toEqual([0, 0, 10])
  })

  it("global fallback without ancestry is tight-only", () => {
    const repo = new Repository()
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], cap(10))
    // Exact position: resolves globally (analogue of the precise-hash rule).
    const qTight = makeAncestryQuery([emitFaceDescriptor([0, 0, 10], [0, 0, 1]), "@X", "@Y"], "flatface")
    expect(repo.query(qTight)).not.toBeNull()
    // Moved position: must NOT loose-match across lineages -> null.
    const qLoose = makeAncestryQuery([emitFaceDescriptor([0, 0, 13], [0, 0, 1]), "@X", "@Y"], "flatface")
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
        emitEdgeDescriptor({ kind: "edge", edgeKind: "line", point: [5, 21, 0], axis: [1, 0, 0], scalar: 10 }),
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
    const q = makeAncestryQuery([emitFaceDescriptor([9, 9, 9], [0, 0, 1]), "@ex1"])
    expect(repo.queryAll(q).length).toBe(1)
  })
})
