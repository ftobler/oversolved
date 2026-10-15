import type { PartDoc } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'

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
  for (const key of VERTEX_POINT_KEYS) {
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
    const sub = (feature.transform ?? feature.delete_body) as unknown as {
      bodies?: unknown
      body?: string
    } | undefined
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
    if (!feature.constraints) continue
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
