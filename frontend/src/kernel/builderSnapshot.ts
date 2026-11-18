// Part-store and repository snapshots for the incremental builder: the
// persisted repo shape, its rehydration, the restore dedupe, and the per-build
// body deep copies.

import { stableJson } from './builderHash'
import { Repository } from './query'
import type { PartSolid } from './types3d'

// ─── Shape / body snapshot helpers ───

/**
 * Owner tag under which every clean-prefix restore copy of one build is
 * registered. Released (``releaseRestoreCopies``) right before the next build
 * overwrites the live store with fresh copies, so the deep ``copyBodyShape``
 * copies cannot accumulate one per body per incremental solve. The tag cannot
 * collide with a feature id (base64url), so it can never match a ``cp:*`` or
 * created-by owner.
 */
export const RESTORE_OWNER = 'restore'

// ``mapShape``, when provided, transforms the body's shape handle for the
// snapshot: retain-in-place at checkpoint time, defensive-copy at restore time.
// Without it the handle is aliased (non-OCC tests).
export type ShapeMapper = (shape: NonNullable<PartSolid['shape']>) => NonNullable<PartSolid['shape']>

function _copyPart(part: PartSolid, mapShape?: ShapeMapper): PartSolid {
  const shape = (part.shape != null && mapShape) ? mapShape(part.shape) : part.shape
  return {
    id: part.id,
    created_by: part.created_by,
    modified_by: [...part.modified_by],
    shape,
    sketch_id: part.sketch_id,
    brep_diff: part.brep_diff,
    profile_queries: [...part.profile_queries],
    ...(part.split_from ? { split_from: { ...part.split_from } } : {}),
    ...(part.face_uuids ? { face_uuids: [...part.face_uuids] } : {}),
    ...(part.edge_uuids ? { edge_uuids: [...part.edge_uuids] } : {}),
    ...(part.face_ancestry ? { face_ancestry: { ...part.face_ancestry } } : {}),
    ...(part.edge_ancestry ? { edge_ancestry: { ...part.edge_ancestry } } : {}),
    ...(part.face_cap_ancestry ? { face_cap_ancestry: { ...part.face_cap_ancestry } } : {}),
    ...(part.face_owner ? { face_owner: { ...part.face_owner } } : {}),
    ...(part.edge_owner ? { edge_owner: { ...part.edge_owner } } : {}),
    // A copied shape keeps the canonical order, so the indices move with it.
    ...(part.brep_new && part.brep_new.shape === part.shape && shape != null
      ? { brep_new: { ...part.brep_new, shape } }
      : {}),
    ...(part.imported ? { imported: true } : {}),
    // Derived from the producing solves, carried with the body so a checkpoint
    // restore hands the next merge the same widening it had before.
    ...(part.precision ? { precision: { ...part.precision } } : {}),
  }
}

/** The persisted repo shape. Exported for the shape guard in `ancestryIndex.test.ts`,
 *  which freezes this THREE-KEY SET: the derived indices must never leak in here,
 *  `repoFromSnapshot` rebuilds them. Nothing hashes the canonical key strings
 *  themselves, so their byte format stays free to change. */
export function snapshotRepo(repo: Repository): Record<string, unknown> {
  return {
    elements: Object.fromEntries(repo.elements),
    ancestral: Object.fromEntries(
      [...repo.ancestral.entries()].map(([k, v]) => [k, { set: [...v.set], eids: [...v.eids] }])
    ),
    byUuid: Object.fromEntries(
      [...repo.byUuid.entries()].map(([k, v]) => [k, [...v]])
    ),
  }
}

export function pickPartsById(partStore: Record<string, PartSolid>, ids: ReadonlySet<string>): Record<string, PartSolid> {
  return Object.fromEntries(Object.entries(partStore).filter(([bid]) => ids.has(bid)))
}

export function snapshotParts(
  partStore: Record<string, PartSolid>,
  mapShape?: ShapeMapper,
): Record<string, PartSolid> {
  return Object.fromEntries(
    Object.entries(partStore).map(([k, v]) => [k, _copyPart(v, mapShape)]),
  )
}

function _dedupeRepo(repo: Repository): void {
  for (const [key, entry] of [...repo.ancestral.entries()]) {
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const elementId of entry.eids) {
      const payload = repo.elements.get(elementId)
      if (payload === undefined) continue
      // The payload-equality predicate shared with the parity fingerprint
      // (`stableJson`, see its doc comment; the structural `payloadEqual` in
      // postRegister.ts is the other, stricter one):
      // recursive stable JSON, so nested object content is hashed. The old
      // allowlist serializer (`Object.keys(payload).sort()`) is a per-level
      // property allowlist, not a key sorter, so nested objects always
      // serialized to `{}` and two payloads differing only in nested content
      // were wrongly merged.
      const payloadHash = stableJson(payload)
      if (seen.has(payloadHash)) {
        repo.deleteElement(elementId)
        continue
      }
      seen.add(payloadHash)
      uniqueIds.push(elementId)
    }
    if (uniqueIds.length) {
      entry.eids = uniqueIds
    } else {
      repo.deleteAncestral(key)
    }
  }
  // A deleted duplicate can empty a uuid bucket outright (it carried its own
  // uuid); prune now so a restore never leaves a dead bucket behind.
  repo.prunePendingUuids()
}

export function repoFromSnapshot(repoSnapshot: Record<string, unknown>): Repository {
  const repo = new Repository()
  if (repoSnapshot.elements || repoSnapshot.ancestral) {
    repo.elements = new Map(Object.entries(repoSnapshot.elements as Record<string, unknown>))
    repo.ancestral = new Map(
      Object.entries(repoSnapshot.ancestral as Record<string, { set: string[]; eids: string[] }>).map(
        ([k, v]) => [k, { set: new Set(v.set), eids: [...v.eids] }]
      )
    )
    repo.byUuid = new Map(
      Object.entries((repoSnapshot.byUuid as Record<string, string[]>) ?? {}).map(([k, v]) => [k, [...v]])
    )
    repo.rebuildIndices()  // the maps were replaced wholesale, so the derived indices are stale
  }
  _dedupeRepo(repo)
  return repo
}
