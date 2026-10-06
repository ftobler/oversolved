// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  initGlobalRepo,
  setCurrentFeatureId,
  emitWire,
  makeAncestryQuery,
  ancestry,
  constructionUuidToken,
  Repository,
  AmbiguousQueryError,
} from "../query"
import type { AncestryQuery } from "../query"
import { postRegister } from "../features/postRegister"

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
