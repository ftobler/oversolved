// Split from query.test.ts; see the original section markers for context.

import { describe, it, expect } from "vitest"
import {
  initGlobalRepo,
  evictAncestryAndRegister,
  parseAncestry,
  makeAncestryQuery,
  canonical,
  Repository,
  AmbiguousQueryError,
} from "./query"
import { postRegister, clearFeatureGeometryRegistrations } from "./features/postRegister"
import { repoFromSnapshot } from "./builder"

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

