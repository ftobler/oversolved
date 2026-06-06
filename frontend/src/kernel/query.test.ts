import { describe, it, expect, beforeEach, afterEach } from "vitest"
import scenarios from "./occ/__fixtures__/queryScenarios.json"
import {
  Repository,
  AmbiguousQueryError,
  initGlobalRepo,
  evictAncestryAndRegister,
  setCurrentFeatureId,
  getCurrentFeatureId,
  featureIdxOfElement,
  isGeomHashId,
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

describe("partial ancestral resolver (tier 2)", () => {
  it("resolves when unique — extra ancestor in query not in registration", () => {
    const repo = new Repository()
    const payload = { type: "face", body_id: "body1", created_by: "ex1" }
    repo.registerAncestor(["@A", "@B"], payload, "gface_hash1")
    const result = repo.query(makeAncestryQuery(["@A", "@B", "@extra"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("ex1")
  })

  it("ambiguous yields no match — two entries both match tier 2 but >1 candidate", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A"], { type: "face", body_id: "body1", created_by: "ex1" }, "gface_a")
    repo.registerAncestor(["@B"], { type: "face", body_id: "body2", created_by: "ex2" }, "gface_b")
    const result = repo.query(makeAncestryQuery(["@A", "@B"]))
    expect(result).toBeNull()
  })

  it("falls to hash when ancestors are disjoint — no subset relation either way", () => {
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

  it("full match wins over partial — tier 1 exact superset returned without scanning tier 2", () => {
    const repo = new Repository()
    repo.registerAncestor(["@A", "@B", "@C"], { type: "face", body_id: "body1", created_by: "full" })
    repo.registerAncestor(["@A", "@B"], { type: "face", body_id: "body2", created_by: "partial" })
    const result = repo.query(makeAncestryQuery(["@A", "@B", "@C"]))
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).created_by).toBe("full")
  })

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

describe("geom-hash fallback (two-tier ancestry resolution)", () => {
  it("isGeomHashId detects prefixes", () => {
    expect(isGeomHashId("@gface_abc123")).toBe(true)
    expect(isGeomHashId("@gedge_abc123")).toBe(true)
    expect(isGeomHashId("@gvertex_abc123")).toBe(true)
    expect(isGeomHashId("@ex1")).toBe(false)
    expect(isGeomHashId("@body_ex1")).toBe(false)
    expect(isGeomHashId("@body_ex1/face0")).toBe(false)
  })

  it("hash in byGeomHash does not affect pure-ancestry queries", () => {
    const repo = new Repository()
    const payload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "gface_abc")

    const result = repo.query(makeAncestryQuery(["@ex1"]))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["created_by"]).toBe("ex1")
  })

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

  it("hash fallback when ancestral query finds nothing", () => {
    const repo = new Repository()
    const payload = makeFacePayload("body1", "ex1", 0)
    repo.registerAncestor(["@body1/face0", "@ex1", "@body1"], payload, "gface_hash1")

    const result = repo.query(makeAncestryQuery(["@gface_hash1"]))
    expect(result).not.toBeNull()
    const r = result as Payload
    expect(r["created_by"]).toBe("ex1")
  })

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
})

describe("ambiguous ancestry queries", () => {
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

  it("coercion happens in exact tier", () => {
    const repo = repoWithFlatface(["@A"])
    const q = makeAncestryQuery(["@A"], "solid")
    expect(repo.query(q, null, bodyStoreWithSolid)).toBe(bodyObj)
  })

  it("coercion skipped in partial tier (type strict filter drops match)", () => {
    const repo = repoWithFlatface(["@A"])
    const q = makeAncestryQuery(["@A", "@extra"], "solid")
    expect(repo.query(q, null, bodyStoreWithSolid)).toBeNull()
  })

  it("partial tier resolves without type restriction", () => {
    const repo = repoWithFlatface(["@A"])
    const q = makeAncestryQuery(["@A", "@extra"])
    const result = repo.query(q, null, bodyStoreWithSolid)
    expect(result).not.toBeNull()
    expect((result as Record<string, unknown>).type).toBe("flatface")
  })

  it("coercion skipped in hash fallback tier (no ancestry = strict type filter)", () => {
    const repo = repoWithFlatface(["@A"], "gface_h")
    const q = makeAncestryQuery(["@gface_h", "@X"], "solid")
    expect(repo.query(q, null, bodyStoreWithSolid)).toBeNull()
  })

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
    const repo = new Repository()
    repo.setFeatureOrder(["ex1", "ex2"])
    reg(repo, ["@sk1"], "ex1")
    reg(repo, ["@sk1"], "ex2")
    const q: AncestryQuery = { kind: "ancestry", ancestorIds: ["@sk1"], typeRestriction: null }

    expect(() => repo.query(q)).toThrow(AmbiguousQueryError)
  })

  it("hash fallback rejects forward match", () => {
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

describe("clearBySketchId", () => {
  it("can leave dangling refs when used standalone", () => {
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

describe("clearFeatureGeometryRegistrations", () => {
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

describe("repoFromSnapshot", () => {
  it("preserves correctness with payloads", () => {
    const original = buildRepoWithPayloads(100)
    const snapshot = makeSnapshot(original)

    const repo = repoFromSnapshot(snapshot)

    for (const [eid, val] of original.elements) {
      expect(repo.elements.get(eid)).toEqual(val)
    }
    expect(new Set(repo.ancestral.keys())).toEqual(new Set(original.ancestral.keys()))
  })

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

  it("handles empty snapshot", () => {
    const repo = repoFromSnapshot({ elements: {}, ancestral: {}, byGeomHash: {} })
    expect(repo.elements.size).toBe(0)
    expect(repo.ancestral.size).toBe(0)
  })

  it("returns empty repo for old-format snapshot (no elements/ancestral wrapper)", () => {
    const oldSnapshot = { e1: { id: "e1", kind: "point", params: [1.0, 2.0] } }
    const repo = repoFromSnapshot(oldSnapshot)
    expect(repo.elements.size).toBe(0)
    expect(repo.ancestral.size).toBe(0)
  })
})

// ─── Ancestral registry lifecycle (ported from test_ancestral_registry_lifecycle.py) ───

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

    let vertexCounts: number[] = []
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

  it("gc removes stale entry", () => {
    const repo = new Repository()
    repo.registerAncestor(["@f1", "surf1"], { type: "flatface" })
    expect(repo.ancestral.size).toBe(1)

    repo.gc(new Set())

    expect(repo.ancestral.size).toBe(0)
    expect(repo.elements.size).toBe(0)
  })

  it("gc keeps active entry", () => {
    const repo = new Repository()
    const eid = repo.registerAncestor(["@f1", "surf1"], { type: "flatface" })
    expect(repo.ancestral.size).toBe(1)

    repo.gc(new Set(["f1"]))

    expect(repo.ancestral.size).toBe(1)
    expect(repo.elements.get(eid)).not.toBeNull()
  })

  it("gc keeps builtin entries", () => {
    const repo = new Repository()
    repo.registerAncestor(["builtin_front", "builtin_plane"], { type: "plane" })

    repo.gc(new Set())

    expect(repo.ancestral.size).toBe(1)
  })

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

// ─── Plane/point type helpers (ported from test_query_standardization.py) ───

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

// ─── B-rep vertex / face integration (ported from test_query_standardization.py,
//      requires OCC build pipeline — skipped in this suite) ───

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
