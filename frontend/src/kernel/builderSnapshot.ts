// Body-store and repository snapshots for the incremental builder: the
// persisted repo shape, its rehydration, the restore dedupe, and the per-build
// body deep copies.

import { stableJson } from './builderHash'
import { Repository } from './query'
import type { Body } from './types3d'

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
export type ShapeMapper = (shape: NonNullable<Body['shape']>) => NonNullable<Body['shape']>

function _copyBody(body: Body, mapShape?: ShapeMapper): Body {
  return {
    id: body.id,
    created_by: body.created_by,
    modified_by: [...body.modified_by],
    shape: (body.shape != null && mapShape) ? mapShape(body.shape) : body.shape,
    sketch_id: body.sketch_id,
    brep_diff: body.brep_diff,
    profile_queries: [...body.profile_queries],
    ...(body.face_names ? { face_names: { ...body.face_names } } : {}),
    ...(body.edge_names ? { edge_names: { ...body.edge_names } } : {}),
    ...(body.face_ancestry ? { face_ancestry: { ...body.face_ancestry } } : {}),
    ...(body.edge_ancestry ? { edge_ancestry: { ...body.edge_ancestry } } : {}),
    ...(body.imported ? { imported: true } : {}),
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

export function pickBodiesById(bodyStore: Record<string, Body>, ids: ReadonlySet<string>): Record<string, Body> {
  return Object.fromEntries(Object.entries(bodyStore).filter(([bid]) => ids.has(bid)))
}

export function snapshotBodies(
  bodyStore: Record<string, Body>,
  mapShape?: ShapeMapper,
): Record<string, Body> {
  return Object.fromEntries(
    Object.entries(bodyStore).map(([k, v]) => [k, _copyBody(v, mapShape)]),
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
