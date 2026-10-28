import type { PartDoc } from '@/types/cad'
import { VERTEX_POINT_KEY_SUFFIXES } from '@/types/vertexKeys'
import { featureRefId } from '@/kernel/query'
import { FEATURE_DEF_SUBKEY, nestedFeatureParams } from '@/kernel/features/shared/featureParams'
import { warn } from './yamlMutations/helpers'

// The load-time migration steps, in the order the ladder applies them. Both
// predate any trustworthy version stamp (a document written with `version: 1`
// can still carry either stale shape), so each is written to be idempotent and
// is safe to run on every load. docSchema.ts owns the ladder that calls them.

// True when a local ref resolves to a single point: a `point` entity referenced
// bare, or a vertex sub-point of another entity (a line end, an arc center, ...).
// Cross-sketch (`@`) refs are out of scope and treated as valid. Used to spot the
// two-point form of horizontal/vertical, whose operands must both be points.
function isPointOperand(ref: unknown, kindById: Map<string, string>): boolean {
  if (typeof ref !== 'string') return false
  if (ref.startsWith('@')) return true
  if (!ref.startsWith('$')) return false
  const bare = ref.slice(1)
  // A whole-entity id wins over the suffix reading: when the bare ref names an
  // entry in the sketch it is that entity, never `<other-entity><vertex-key>`,
  // even if it happens to end with a vertex key. Only a point entity counts.
  if (kindById.has(bare)) return kindById.get(bare) === 'point'
  for (const key of VERTEX_POINT_KEY_SUFFIXES) {
    if (bare.length > key.length && bare.endsWith(key)) {
      const eid = bare.slice(0, -key.length)
      if (kindById.has(eid)) return true
    }
  }
  return false
}

// The transform/delete_body body pick became a LIST in 2026-07 (delete_body in
// fa72b97a on the 27th, transform in 0eab4115 on the 29th). Docs authored
// before that carry the singular `body` key and no `bodies`; the kernel reads
// only `bodies`, so such a doc solves to nothing, and the list mutators crash
// on a missing `bodies`. Every parse seam runs this migration right after
// dropDeadAxisConstraints, so a legacy doc is healed once at load and never
// ships its singular ref to the UI or the solver. Mirrors dropDeadAxisConstraints:
// mutate in place, return the count of features rewritten. Idempotent (a second
// pass rewrites nothing). The mirror feature's own singular `body` is
// intentional and untouched.
export function migrateLegacyBodyPicks(doc: PartDoc): number {
  let rewritten = 0
  for (const feature of doc.features ?? []) {
    if (feature.kind !== 'transform' && feature.kind !== 'delete_body') continue
    // The pre-migration shape is a lie about the typed def (that is the whole
    // point of this pass), so the fields are read through a widened view. A raw
    // record can also name the kind without carrying the def at all (the loader
    // validates a payload when present, it does not require one); that row is
    // skipped like the pre-union pass did, so one malformed feature cannot
    // abort the heal for every row after it.
    const sub: { bodies?: unknown; body?: string } | undefined =
      feature.kind === 'transform' ? feature.transform : feature.delete_body
    if (!sub) continue
    if (!Array.isArray(sub.bodies) && typeof sub.body === 'string') {
      sub.bodies = sub.body ? [sub.body] : []
      rewritten += 1
    }
    delete sub.body
  }
  return rewritten
}

// Self-cleanup for stale documents: drop horizontal/vertical constraints whose
// two-point (a/b) form references a whole non-point entity (e.g. a circle or an
// extra line picked up alongside the real target). Such an operand resolves to a
// single sub-point, so the residual is degenerate and already satisfied -- the
// line never turns axis-aligned and a stray symbol floats on the canvas. These
// can no longer be authored (applyAddConstraint rejects them) but documents from
// before that fix may still carry them. Returns the number removed.
// See bugreports/weird_constraint_20260621_214037.md.
export function dropDeadAxisConstraints(doc: PartDoc): number {
  let removed = 0
  for (const feature of doc.features ?? []) {
    if (feature.kind !== 'sketch' || !feature.constraints) continue
    const kindById = new Map((feature.entities ?? []).map(e => [e.id, e.kind]))
    const before = feature.constraints.length
    feature.constraints = feature.constraints.filter(c => {
      if (c.kind !== 'horizontal' && c.kind !== 'vertical') return true
      if (c.a === undefined || c.b === undefined) return true  // single-line target form
      return isPointOperand(c.a, kindById) && isPointOperand(c.b, kindById)
    })
    removed += before - feature.constraints.length
  }
  return removed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rewrite a feature-level reference to a feature from the legacy `$id` local
 * spelling to the canonical `@id` absolute one. Only refs whose bare id names a
 * feature IN THIS DOCUMENT are touched, so a host-local sketch constraint
 * operand (`$line1`, kept local) and the legacy `$sketch.entity` sweep-path form
 * are left alone. Walks each sub-def (the kind key; `definition` for a plane)
 * recursively; a kind with no sub-def (sketch's own constraints) is never
 * entered. Idempotent: a second pass finds no `$` feature refs.
 */
export function migrateFeatureRefsToAbsolute(doc: PartDoc): number {
  const features = doc.features
  if (!features) return 0
  const known = new Set(features.map(f => f.id))
  let rewritten = 0
  for (const feature of features) {
    const row = feature as unknown as Record<string, unknown>
    const kind = row.kind
    if (typeof kind !== 'string') continue
    const subKey = FEATURE_DEF_SUBKEY[kind as keyof typeof FEATURE_DEF_SUBKEY]
    if (subKey === undefined) continue
    const sub = row[subKey]
    if (sub === undefined) continue
    const { value, count } = rewriteFeatureRefsIn(sub, known)
    if (count > 0) {
      row[subKey] = value
      rewritten += 1
    }
  }
  return rewritten
}

function rewriteFeatureRefsIn(value: unknown, known: ReadonlySet<string>): { value: unknown; count: number } {
  if (typeof value === 'string') {
    const id = featureRefId(value)
    // Only the legacy `$` spelling is rewritten; `@` is already canonical.
    if (id !== null && value[0] === '$' && known.has(id)) return { value: '@' + id, count: 1 }
    return { value, count: 0 }
  }
  if (Array.isArray(value)) {
    // A hostile document can carry a sparse billion-entry array (the loader's
    // own cap is MAX_FEATURE_LIST); walking it here would hang the migration.
    // Anything over the cap is left for the validator to refuse by field.
    if (value.length > REF_WALK_LIST_CAP) return { value, count: 0 }
    let count = 0
    const out = value.map(v => {
      const r = rewriteFeatureRefsIn(v, known)
      count += r.count
      return r.value
    })
    return count > 0 ? { value: out, count } : { value, count: 0 }
  }
  if (isRecord(value)) {
    let count = 0
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const r = rewriteFeatureRefsIn(v, known)
      count += r.count
      if (r.value !== v) changed = true
      out[k] = r.value
    }
    return changed ? { value: out, count } : { value, count: 0 }
  }
  return { value, count: 0 }
}

// Mirrors persistence/docSchema's MAX_FEATURE_LIST; a ref list never approaches
// it, and walking a larger one would hang on a hostile sparse array.
const REF_WALK_LIST_CAP = 10_000

/**
 * Canonicalize feature params: fold every non-base flat field into the feature's
 * sub-def (the kind key; `definition` for a plane). Flat wins on conflict, the
 * same rule the old leaf-solver overlay used, so folding changes no geometry;
 * the shadowed nested value is logged. A kind with no sub-def, or one with
 * nothing flat, is left alone. Idempotent. Returns the number of features
 * rewritten. Mirrors nestedFeatureParams, the runtime helper the solver adapter
 * shares, so load and solve agree on where a param lives.
 */
export function canonicalizeFeatureParams(doc: PartDoc): number {
  const features = doc.features
  if (!features) return 0
  let moved = 0
  for (const feature of features) {
    const row = feature as unknown as Record<string, unknown>
    if (typeof row.kind !== 'string') continue
    const { feature: canonical, dropped } = nestedFeatureParams(row)
    if (canonical === row) continue
    for (const key of Object.keys(row)) delete row[key]
    Object.assign(row, canonical)
    moved += 1
    if (dropped.length > 0) {
      warn(`docSchema: flat params moved into the sub-def, overriding the nested value: ${dropped.join(', ')}`)
    }
  }
  return moved
}
