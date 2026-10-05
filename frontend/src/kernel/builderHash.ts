// Checkpoint / result hashing and repo-snapshot diffing used by the builder's
// validation ladder. Pure helpers with no dependency on builder.ts, so they can
// be reused and tested directly.

import { sha256Hex } from './sha256'
import type { BuildState, FeatureCheckpoint } from './types3d'

// ─── Hash / validation helpers ───

// The canonical payload-equality predicate for the restore dedupe (`_dedupeRepo`)
// and the parity fingerprint (`repoFingerprintTestUtil`). Stable under object key
// order (recursive key sort)
// and Map entry order (Maps become sorted-key objects), and normalizes `-0` to
// `0`. It does NOT hash every content difference: JSON.stringify drops
// undefined-valued object keys (`{a:1,b:undefined}` hashes like `{a:1}`) and
// serializes undefined array elements and NaN in arrays and object values as
// `null`, so `[1,undefined]` collides with `[1,null]` and `{a:NaN}` with
// `{a:null}`; a Map also collides with a plain object carrying the same entries.
// Equal hashes are therefore a coarser equality than content identity: only
// payloads that really differ as JSON-clean JSON are guaranteed to hash
// differently. The collisions are pre-existing and shared by the two uses
// above, so they can never diverge live vs restored, but a future payload that
// accidentally carries an undefined or NaN value will silently merge distinct
// elements. It is NOT the only payload-equality predicate in the codebase:
// `registerAncestralDeduped` (postRegister.ts) dedupes with a structural
// `payloadEqual` that keeps undefined-valued object keys, so the two predicates
// disagree exactly on a payload carrying one (here it merges with the key-less
// twin, there it stays distinct). No current payload carries an undefined key, so
// the divergence is latent; a future one will behave differently in the two
// dedupes.
export function stableJson(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v instanceof Map) {
      // Codepoint order, not localeCompare: the sort only needs a total order
      // that is identical in every environment, since this serialization
      // underpins every checkpoint and parity hash.
      const entries = [...v.entries()].sort((a, b) => {
        const ka = String(a[0])
        const kb = String(b[0])
        return ka < kb ? -1 : ka > kb ? 1 : 0
      })
      return Object.fromEntries(entries)
    }
    if (typeof v === 'number' && Object.is(v, -0)) return 0
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) sorted[key] = (v as Record<string, unknown>)[key]
      return sorted
    }
    return v
  })
}

function _roundFloats(obj: unknown, ndigits: number): unknown {
  if (typeof obj === 'number') {
    const r = Number(obj.toFixed(ndigits))
    return Object.is(r, -0) ? 0 : r
  }
  if (Array.isArray(obj)) return obj.map((v) => _roundFloats(v, ndigits))
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = _roundFloats(v, ndigits)
    return out
  }
  return obj
}

const RESULT_NON_GEOMETRIC_KEYS = new Set(['solve_ms'])

function _stripNonGeometric(obj: unknown): unknown {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (!RESULT_NON_GEOMETRIC_KEYS.has(k)) out[k] = _stripNonGeometric(v)
    }
    return out
  }
  if (Array.isArray(obj)) return obj.map(_stripNonGeometric)
  return obj
}

export function hashCheckpointSpec(cp: FeatureCheckpoint): string {
  return sha256Hex(stableJson(cp.spec))
}

export function hashResultDict(result: Record<string, unknown>, fpRound?: number | null): string {
  let payload = _stripNonGeometric(result)
  if (fpRound != null) payload = _roundFloats(payload, fpRound)
  return sha256Hex(stableJson(payload))
}

export function diffRepoSnapshot(
  a: BuildState,
  b: BuildState,
  featureIdx?: number | null,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {}
  if (JSON.stringify(a.feature_order) !== JSON.stringify(b.feature_order)) {
    diff['feature_order'] = { a: a.feature_order, b: b.feature_order }
  }
  const fids = featureIdx != null ? [a.feature_order[featureIdx]] : a.feature_order
  for (const fid of fids) {
    const cpA = a.checkpoints[fid]
    const cpB = b.checkpoints[fid]
    if (!cpA || !cpB) {
      const arr = (diff['missing_checkpoints'] ??= []) as unknown[]
      arr.push(fid)
      continue
    }
    const aBodies = Object.fromEntries(
      Object.entries(cpA.body_store_snapshot).map(([bid, body]) => [
        bid,
        { created_by: body.created_by, modified_by: [...body.modified_by] },
      ])
    )
    const bBodies = Object.fromEntries(
      Object.entries(cpB.body_store_snapshot).map(([bid, body]) => [
        bid,
        { created_by: body.created_by, modified_by: [...body.modified_by] },
      ])
    )
    if (JSON.stringify(aBodies) !== JSON.stringify(bBodies)) {
      const store = (diff['body_store'] ??= {}) as Record<string, unknown>
      store[fid] = { a: aBodies, b: bBodies }
    }
    const aRepo = cpA.repo_snapshot as Record<string, unknown>
    const bRepo = cpB.repo_snapshot as Record<string, unknown>
    const aAncestral = aRepo.ancestral as Record<string, unknown> | undefined
    const bAncestral = bRepo.ancestral as Record<string, unknown> | undefined
    const aKeys = new Set(aAncestral ? Object.keys(aAncestral) : [])
    const bKeys = new Set(bAncestral ? Object.keys(bAncestral) : [])
    const added = [...bKeys].filter((k) => !aKeys.has(k)).sort()
    const removed = [...aKeys].filter((k) => !bKeys.has(k)).sort()
    if (added.length || removed.length) {
      const ra = (diff['repo_ancestral'] ??= {}) as Record<string, unknown>
      ra[fid] = {
        added: added.slice(0, 20),
        removed: removed.slice(0, 20),
        added_total: added.length,
        removed_total: removed.length,
      }
    }
  }
  return diff
}
