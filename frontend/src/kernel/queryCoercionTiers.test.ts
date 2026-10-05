// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  makeAncestryQuery,
  constructionUuidToken,
  Repository,
  AmbiguousQueryError,
} from "./query"

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

