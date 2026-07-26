// Test-only invariant checks for the Repository's derived indices (`byAncestorId`,
// `elementUuid`). They are maintained incrementally at every mutation site, so what
// will silently rot is a new site mutating `ancestral` / `elements` directly instead
// of going through `deleteAncestral` / `deleteElement`. Assert
// `assertRepoIndicesConsistent` after any mutation batch to catch that.

import type { Repository } from "./query"

/** Recompute `byAncestorId` from scratch: ancestor id -> keys of the entries carrying it. */
export function recomputeByAncestorId(repo: Repository): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const [key, entry] of repo.ancestral) {
    for (const id of entry.set) {
      let keys = index.get(id)
      if (!keys) {
        keys = new Set()
        index.set(id, keys)
      }
      keys.add(key)
    }
  }
  return index
}

/** Recompute `elementUuid`: every LIVE element listed in a `byUuid` bucket, mapped to
 *  that uuid. Dead eids are excluded on both sides, which makes this an exact identity. */
export function recomputeElementUuid(repo: Repository): Map<string, string> {
  const index = new Map<string, string>()
  for (const [uuid, eids] of repo.byUuid) {
    for (const eid of eids) if (repo.elements.has(eid)) index.set(eid, uuid)
  }
  return index
}

/** Flatten an ancestor index to a comparable, order-independent form. */
function flatten(index: Map<string, Set<string>>): string {
  return JSON.stringify(
    [...index].map(([id, keys]) => [id, [...keys].sort()] as const).sort(),
  )
}

/** Throw unless both derived indices agree with a from-scratch recomputation. Both
 *  are exact identities: `byAncestorId` derives from `ancestral`, and `elementUuid`
 *  holds exactly the LIVE members of `byUuid` (`rebuildIndices` filters dead eids for
 *  precisely this reason), so a dropped `elementUuid.delete` in `deleteElement`
 *  surfaces here as a stale key. */
export function assertRepoIndicesConsistent(repo: Repository): void {
  const live = flatten(repo.byAncestorId)
  const want = flatten(recomputeByAncestorId(repo))
  if (live !== want) throw new Error(`byAncestorId out of sync:\n live=${live}\n want=${want}`)

  const liveUuid = JSON.stringify([...repo.elementUuid].sort())
  const wantUuid = JSON.stringify([...recomputeElementUuid(repo)].sort())
  if (liveUuid !== wantUuid) {
    throw new Error(`elementUuid out of sync:\n live=${liveUuid}\n want=${wantUuid}`)
  }
}

/** Throw if any `byUuid` bucket has lost every live element: the pruning the index
 *  replaced. Only holds at a drain point (after `evictAncestryAndRegister` / `gc`). */
export function assertNoDeadUuidBuckets(repo: Repository): void {
  for (const [uuid, eids] of repo.byUuid) {
    if (!eids.some(eid => repo.elements.has(eid))) {
      throw new Error(`byUuid[${uuid}] has no live element left but was not pruned`)
    }
  }
}
