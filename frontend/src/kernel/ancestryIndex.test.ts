// Guards for the `byAncestorId` / `elementUuid` reverse indices that make one
// ancestry registration pass linear (feature: ancestry-registration-quadratic).
// Before them, `evictAncestryAndRegister` full-scanned `ancestral` and `byUuid` on
// every call, so registering a 62k-entity STEP assembly cost 288s per pass.

import { describe, it, expect } from "vitest"
import { Repository, evictAncestryAndRegister, canonical } from "./query"
import { snapshotRepo, repoFromSnapshot } from "./builder"
import { clearFeatureGeometryRegistrations } from "./features/postRegister"
import { assertRepoIndicesConsistent, assertNoDeadUuidBuckets } from "./repoIndexTestUtil"

/** Ancestor ids and payload shaped like `_registerBrepFaceAncestry`'s. */
function registerFace(repo: Repository, bodyId: string, faceIdx: number, uuid: string | null = null) {
  const indexTag = `@${bodyId}/face${faceIdx}`
  const ancestorIds = [indexTag, "@extrude1", `@${bodyId}`, "?4;prof"]
  const payload = {
    type: "flatface",
    body_id: bodyId,
    created_by: "extrude1",
    face_index: faceIdx,
    centroid: [faceIdx, 0, 0],
    normal: [0, 0, 1],
    origin: [faceIdx, 0, 0],
    x_axis: [1, 0, 0],
    y_axis: [0, 1, 0],
    classifiers: [],
  }
  return evictAncestryAndRegister(repo, ancestorIds, payload, indexTag, uuid)
}

describe("ancestry registration scaling", () => {
  // Red-green guard, not a micro-benchmark: the quadratic version needs ~288s for
  // this, the indexed one well under a second. The budget has ~30x headroom so a
  // slow CI box cannot flake it. Deliberately no ratio between two sizes.
  it("registers 60k entities in linear time", () => {
    const repo = new Repository()
    const started = Date.now()
    for (let i = 0; i < 60_000; i++) registerFace(repo, "body_a", i)
    const elapsed = Date.now() - started

    expect(repo.ancestral.size).toBe(60_000)
    expect(elapsed).toBeLessThan(10_000)
  })
})

describe("eviction semantics", () => {
  it("evicts the old entry when an index tag moves to a different ancestral key", () => {
    const repo = new Repository()
    const tag = "@body_b/face0"
    const oldEid = evictAncestryAndRegister(repo, [tag, "@f1"], { type: "face", n: 1 }, tag)

    const newEid = evictAncestryAndRegister(repo, [tag, "@f1", "@f2"], { type: "face", n: 2 }, tag)

    expect(repo.elements.has(oldEid)).toBe(false)
    expect(repo.elements.has(newEid)).toBe(true)
    expect(repo.ancestral.has(canonical([tag, "@f1"]))).toBe(false)
    assertRepoIndicesConsistent(repo)
  })

  it("does not evict when the same index tag re-registers under the same key", () => {
    const repo = new Repository()
    const tag = "@body_b/face0"
    const ids = [tag, "@f1"]
    evictAncestryAndRegister(repo, ids, { type: "face", n: 1 }, tag)
    const second = evictAncestryAndRegister(repo, ids, { type: "face", n: 2 }, tag)

    // The exact-key branch still replaces the payload, so exactly one survives.
    const entry = repo.ancestral.get(canonical(ids))
    expect(entry?.eids).toEqual([second])
    expect(repo.elements.get(second)).toMatchObject({ n: 2 })
    assertRepoIndicesConsistent(repo)
  })

  it("evicts an entry that merely contains another entry's index tag", () => {
    // Pins "index every ancestor id, not just tag-shaped ones": the neighbour below
    // carries `tag` as a plain ancestor, never as its own index tag. Narrowing the
    // index to tag-shaped ids would silently stop evicting it.
    const repo = new Repository()
    const tag = "@body_b/face0"
    const neighbour = evictAncestryAndRegister(
      repo, ["@body_b/edge3", tag, "@f1"], { type: "edge" }, "@body_b/edge3",
    )
    expect(repo.elements.has(neighbour)).toBe(true)

    evictAncestryAndRegister(repo, [tag, "@f1"], { type: "face" }, tag)

    expect(repo.elements.has(neighbour)).toBe(false)
    expect(repo.ancestral.has(canonical(["@body_b/edge3", tag, "@f1"]))).toBe(false)
    assertRepoIndicesConsistent(repo)
  })

  it("drops a uuid once its last element is gone and keeps it while one survives", () => {
    const repo = new Repository()
    const tag = "@body_b/face0"
    evictAncestryAndRegister(repo, [tag, "@f1"], { type: "face", n: 1 }, tag, "u_old")
    // A second element shares u_shared and lives under an untouched ancestral key.
    repo.registerAncestor(["@unrelated"], { type: "face" }, "u_shared")
    evictAncestryAndRegister(repo, [tag, "@f2"], { type: "face", n: 2 }, tag, "u_shared")

    expect(repo.byUuid.has("u_old")).toBe(false)  // its only element was evicted
    expect(repo.byUuid.get("u_shared")?.length).toBe(2)

    // Evicting the u_shared member registered under the tag leaves the other alive.
    evictAncestryAndRegister(repo, [tag, "@f3"], { type: "face", n: 3 }, tag, "u_new")
    expect(repo.byUuid.has("u_shared")).toBe(true)
    assertNoDeadUuidBuckets(repo)
    assertRepoIndicesConsistent(repo)
  })
})

describe("index integrity across mutation sites", () => {
  function seeded(): Repository {
    const repo = new Repository()
    for (let i = 0; i < 6; i++) registerFace(repo, "body_a", i, `u_a${i}`)
    for (let i = 0; i < 4; i++) registerFace(repo, "body_b", i, `u_b${i}`)
    repo.registerAncestor(["@sketch1/line1", "@sketch1"], { type: "flatface", sketch_id: "sketch1" })
    repo.register("sketch1/line1", { external_params: [0, 0, 1, 0], sketch_id: "sketch1" })
    return repo
  }

  it("holds after a registration batch", () => {
    const repo = seeded()
    assertRepoIndicesConsistent(repo)
    expect(repo.byAncestorId.get("@extrude1")?.size).toBe(10)
  })

  it("holds after gc()", () => {
    const repo = seeded()
    repo.gc(new Set(["sketch1"]))
    expect(repo.ancestral.has(canonical(["@body_a/face0", "@extrude1", "@body_a", "?4;prof"]))).toBe(false)
    assertRepoIndicesConsistent(repo)
    assertNoDeadUuidBuckets(repo)
  })

  it("holds after clearBySketchId()", () => {
    const repo = seeded()
    repo.clearBySketchId("sketch1")
    expect(repo.elements.has("sketch1/line1")).toBe(false)
    assertRepoIndicesConsistent(repo)
  })

  it("holds after a postRegister eviction", () => {
    const repo = seeded()
    clearFeatureGeometryRegistrations(repo, "extrude1")
    expect(repo.byAncestorId.has("@extrude1")).toBe(false)
    assertRepoIndicesConsistent(repo)
  })

  it("holds after a snapshotRepo -> repoFromSnapshot round-trip (with _dedupeRepo)", () => {
    const repo = seeded()
    // Two ancestral keys carrying byte-identical payloads, so _dedupeRepo fires
    // inside repoFromSnapshot and deletes elements + an entry after the rebuild.
    repo.registerAncestor(["@dupe"], { type: "face", tag: "same" }, "u_dupe")
    repo.registerAncestor(["@dupe"], { type: "face", tag: "same" }, "u_dupe")

    const restored = repoFromSnapshot(snapshotRepo(repo))

    expect(restored.ancestral.get(canonical(["@dupe"]))?.eids.length).toBe(1)
    expect(restored.byAncestorId.get("@extrude1")?.size).toBe(10)
    assertRepoIndicesConsistent(restored)
  })

  it("survives further eviction on a restored repo", () => {
    // The rebuilt index must be USABLE, not merely self-consistent. Re-registering
    // under a DIFFERENT ancestor set carrying the same tag is what forces the
    // eviction through `byAncestorId`: an identical set would hit the exact-key
    // branch and pass even with an empty rebuilt index.
    const restored = repoFromSnapshot(snapshotRepo(seeded()))
    const tag = "@body_a/face0"
    const stale = restored.ancestral.get(canonical([tag, "@extrude1", "@body_a", "?4;prof"]))!.eids[0]

    evictAncestryAndRegister(restored, [tag, "@extrude1", "@body_a", "?4;other"], { type: "face" }, tag, "u_a0_new")

    expect(restored.elements.has(stale)).toBe(false)
    expect(restored.ancestral.has(canonical([tag, "@extrude1", "@body_a", "?4;prof"]))).toBe(false)
    expect(restored.byUuid.has("u_a0")).toBe(false)
    assertRepoIndicesConsistent(restored)
    assertNoDeadUuidBuckets(restored)
  })

  it("tracks elementUuid for elements restored from a snapshot", () => {
    // Isolates `rebuildIndices`' elementUuid half: deleting a restored element must
    // still prune its bucket, which only works if the rebuild mapped it.
    const restored = repoFromSnapshot(snapshotRepo(seeded()))
    const eid = restored.byUuid.get("u_b3")![0]
    expect(restored.elementUuid.get(eid)).toBe("u_b3")

    restored.deleteElement(eid)
    restored.prunePendingUuids()

    expect(restored.byUuid.has("u_b3")).toBe(false)
    assertRepoIndicesConsistent(restored)
  })
})

describe("persisted repo shape", () => {
  it("keeps the derived indices out of the snapshot", () => {
    const repo = new Repository()
    registerFace(repo, "body_a", 0, "u_a0")
    // A derived index that leaked in here would be stale by construction: restore
    // goes through `repoFromSnapshot`, which reads exactly these three and then
    // calls `rebuildIndices()`. Persisting one is dead weight a later restore path
    // could start trusting instead of rebuilding.
    expect(Object.keys(snapshotRepo(repo)).sort()).toEqual(["ancestral", "byUuid", "elements"])
  })
})
