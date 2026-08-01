// Test-only semantic fingerprint of a persisted repo snapshot (`FeatureCheckpoint.repo_snapshot`).
//
// Element ids come from a module-global counter (`genId`, query.ts), so they shift whenever
// the number of registrations anywhere in the build changes. Byte-comparing two snapshots
// therefore proves nothing about equivalence. What must NOT shift is which payloads are
// reachable under which ancestral key and which uuid -- that is what this fingerprint pins.
//
// It is normalised the way `repoFromSnapshot` normalises: duplicate payloads under one
// ancestral key are collapsed, because every consumer of a persisted snapshot rehydrates it
// through `repoFromSnapshot`, which runs `_dedupeRepo` first. A pass that registers a payload
// the snapshot already carries is therefore unobservable, and that is exactly the redundancy
// `double-registration-pass` removed. Losing a payload entirely is NOT hidden.

/** Deterministic JSON for a payload: recursive key sort, `-0` normalised to `0`. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'number' && Object.is(v, -0)) return 0
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(v as object).sort()) sorted[key] = (v as Record<string, unknown>)[key]
      return sorted
    }
    return v
  })
}

interface SnapshotAncestralEntry {
  set: string[]
  eids: string[]
}

/**
 * Eid-free fingerprint of a persisted repo snapshot: stable across eid renumbering and
 * across redundant re-registration, sensitive to any payload actually appearing,
 * disappearing or changing under a key / uuid.
 */
export function repoSemanticFingerprint(snapshot: Record<string, unknown>): string {
  const elements = (snapshot.elements as Record<string, unknown> | undefined) ?? {}
  const ancestral = (snapshot.ancestral as Record<string, SnapshotAncestralEntry> | undefined) ?? {}
  const byUuid = (snapshot.byUuid as Record<string, string[]> | undefined) ?? {}

  // Replay `_dedupeRepo`: per ancestral key, the second and later eids carrying an
  // already-seen payload are DELETED elements, so they are gone from the uuid view too.
  const dead = new Set<string>()
  for (const key of Object.keys(ancestral)) {
    const seen = new Set<string>()
    for (const eid of ancestral[key].eids) {
      if (!(eid in elements)) continue
      const payload = stableJson(elements[eid])
      if (seen.has(payload)) dead.add(eid)
      else seen.add(payload)
    }
  }
  const isLive = (eid: string): boolean => eid in elements && !dead.has(eid)
  const payloadsOf = (eids: string[]): string[] =>
    eids.filter(isLive).map((eid) => stableJson(elements[eid])).sort()

  const claimed = new Set<string>()
  const ancestralOut: Array<[string, string[]]> = []
  for (const key of Object.keys(ancestral).sort()) {
    for (const eid of ancestral[key].eids) claimed.add(eid)
    const payloads = payloadsOf(ancestral[key].eids)
    if (payloads.length) ancestralOut.push([key, payloads])  // an all-dead key is dropped on rehydrate
  }

  const uuidOut: Array<[string, string[]]> = Object.keys(byUuid)
    .sort()
    .map((uuid) => [uuid, payloadsOf(byUuid[uuid])] as [string, string[]])
    .filter(([, payloads]) => payloads.length)

  // Elements registered under a fixed id rather than through an ancestral key
  // (`_topo_<fid>`, `_pt_<fid>`, builtin planes): their id IS their identity, so keep it.
  const looseOut: Array<[string, string]> = Object.keys(elements)
    .filter((eid) => !claimed.has(eid))
    .sort()
    .map((eid) => [eid, stableJson(elements[eid])] as [string, string])

  return JSON.stringify({ ancestral: ancestralOut, byUuid: uuidOut, elements: looseOut })
}

/** Fingerprint every checkpoint of a build state, keyed by feature id. */
export function checkpointFingerprints(
  checkpoints: Record<string, { repo_snapshot: Record<string, unknown> }>,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(checkpoints).sort().map((fid) => [fid, repoSemanticFingerprint(checkpoints[fid].repo_snapshot)]),
  )
}
