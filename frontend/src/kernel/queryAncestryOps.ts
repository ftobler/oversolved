// Ancestry registration/eviction operations over a Repository: the global repo
// seed, index-tag eviction, and the body-scoped sweeps. Split out of query.ts;
// query.ts re-exports the public surface unchanged.

import { Repository, canonical } from './queryRepository'
import { isDict } from './queryCoerce'
import { ref } from './queryWire'
import { BUILTIN_PLANES } from './solverConstants'

/** Create and populate the global repository with built-in planes and origin. */
export function initGlobalRepo(): Repository {
  const repo = new Repository()
  repo.register("builtin_origin", { external_xy: [0.0, 0.0] })
  for (const [name, plane] of Object.entries(BUILTIN_PLANES)) repo.register(name, plane)
  return repo
}

/** Evict stale ancestry entries and register a new one. */
export function evictAncestryAndRegister(
  repo: Repository,
  ancestorIds: string[],
  payload: Record<string, unknown>,
  indexTag: string | null = null,
  uuid: string | null = null,
): string {
  const key = canonical(ancestorIds)

  if (indexTag !== null) {
    // Only the entries actually carrying the tag, via the reverse index: scanning all
    // of `ancestral` here made a whole registration pass quadratic (288s on a 62k
    // entity STEP assembly). The spread is over the matched keys, not the repo.
    const tagged = repo.byAncestorId.get(indexTag)
    if (tagged) {
      for (const k of [...tagged]) {
        if (k === key) continue
        const entry = repo.ancestral.get(k)
        if (entry === undefined) {
          tagged.delete(k)  // index rot: self-heal rather than let the dangling key persist
          continue
        }
        for (const eid of entry.eids) repo.deleteElement(eid)
        repo.deleteAncestral(k)
      }
    }
  }

  const exact = repo.ancestral.get(key)
  if (exact) {
    for (const eid of exact.eids) repo.deleteElement(eid)
    repo.deleteAncestral(key)
  }

  repo.prunePendingUuids()

  return repo.registerAncestor(ancestorIds, payload, uuid)
}

/** Evict every ancestral entry whose set carries `@bodyId` - a body's whole
 *  face/edge/vertex index range at once - and prune the uuid buckets their
 *  elements left behind. Body-scoped via the reverse index (O(entries sharing
 *  the tag), not O(repo)), the same lookup `evictAncestryAndRegister` uses for
 *  its index-tag spread. Call before re-registering a body's range so a
 *  shrunken range replaces the old one wholesale instead of leaving indices
 *  k..N-1 resolvable forever; delete_body routes through it too. */
export function clearBodyAncestry(repo: Repository, bodyId: string): void {
  const tagged = repo.byAncestorId.get('@' + bodyId)
  if (!tagged) return
  for (const key of [...tagged]) {
    const entry = repo.ancestral.get(key)
    if (entry === undefined) {
      tagged.delete(key)  // index rot: self-heal rather than let the dangling key persist
      continue
    }
    for (const eid of entry.eids) repo.deleteElement(eid)
    repo.deleteAncestral(key)
  }
  repo.prunePendingUuids()
}

/** Evict every repo entry a body owns once the body itself is gone: its whole
 *  face/edge/vertex index range (`clearBodyAncestry`) plus the solid element the
 *  creating feature registered under its own bare `@<createdBy>` tag (which
 *  carries no body tag, so the sweep above cannot see it).
 *
 *  Two callers: `delete_body`, and the build loop when a feature CONSUMES a body
 *  (a boolean tool, an array/fuse source). Without the second, the consumed
 *  body's faces stay live in the repo carrying the very construction UUIDs the
 *  surviving body inherited from them, and the resolver's UUID tier reports a
 *  "collision by construction" on every pick of such a face. */
export function clearConsumedBodyAncestry(
  repo: Repository,
  bodyId: string,
  createdBy: string,
): void {
  clearBodyAncestry(repo, bodyId)
  if (!createdBy) return
  const key = canonical([ref(createdBy)])
  const entry = repo.ancestral.get(key)
  if (entry === undefined) return
  const doomed = new Set(
    entry.eids.filter(eid => {
      const el = repo.elements.get(eid)
      return isDict(el) && el["body_id"] === bodyId
    }),
  )
  if (doomed.size === 0) return
  for (const eid of doomed) repo.deleteElement(eid)
  entry.eids = entry.eids.filter(eid => !doomed.has(eid))
  if (entry.eids.length === 0) repo.deleteAncestral(key)
  repo.prunePendingUuids()
}
