import type { PartDoc, Mutation } from '@/types/cad'
import { failLoud } from '@/utils/invariants'

// The no-op slice guard, shared by the hook funnel and the DocSession so the
// two paths cannot classify a dead step differently. Lifted verbatim from
// usePartDoc when the session layer was added; the classification table it
// binds to is IDEMPOTENT_MUTATION in hooks/mutationIdempotence.ts.

// The body-style mutations whose no-op slice keys on a single part_style
// entry. A missing bodyId writes part_style[undefined] - a real doc change the
// slice cannot represent - so these are the ones the guard must never swallow.
export const BODY_STYLE_MUTATION_TYPES = new Set<Mutation['type']>([
  'rename_part',
  'set_body_visibility',
  'set_part_color',
  'set_part_transparency',
  'set_part_metalness',
  'set_part_roughness',
  'set_part_transmission',
])

// The slice value meaning "do not no-op guard this mutation". A body-style
// mutation without a bodyId is a programming error (failLoud flags it, like
// the set_rollback pre-sync guard) but the doc change is still real, so in
// prod the mutation must always push; the bypass skips the stringify compare.
export const GUARD_BYPASS = Symbol('noOpSliceFor.guardBypass')

// A serializable key of only the parts of `doc` an idempotent mutation can
// change, so the no-op guard compares O(touched) instead of O(doc). The
// rollback mirror writes doc.rollback outside a session, so that is always
// included; a feature mutation narrows to its feature (a reorder to the order
// alone, since it never touches content); a body-style mutation to its single
// part_style entry. Every idempotent handler stays within these, so a change
// the handlers made can never be invisible to the slice.
export function noOpSliceFor(m: Mutation, doc: PartDoc): unknown {
  // `in` narrows the discriminated union, where a cast through
  // `{ featureId?: string }` could not: a variant that drops or renames either
  // key stops matching here instead of silently reading back undefined.
  // Narrowing alone is not enough though, since a variant can carry its target
  // under a key this function never learns to read; the classification is what
  // is bound to those keys, by SliceReadableMutation in mutationIdempotence.
  const featureId = 'featureId' in m ? m.featureId : undefined
  const bodyId = 'bodyId' in m ? m.bodyId : undefined
  if (bodyId === undefined && BODY_STYLE_MUTATION_TYPES.has(m.type)) {
    failLoud('[noOpGuard] body-style mutation dispatched without a bodyId')
    return GUARD_BYPASS
  }
  const slice: Record<string, unknown> = {}
  if (doc.rollback !== undefined) slice.rollback = doc.rollback
  if (m.type === 'reorder_features') {
    slice.features = (doc.features ?? []).map(f => f.id)
  } else if (m.type === 'remove_dangling_content') {
    // The cleanup names the features it might touch in its payload; slice those
    // whole, or the compare would be blind to the content it removes. Required
    // by the type, and the handler reads it before this runs, so there is no
    // absent-plan case left to absorb.
    const touched = Object.keys(m.features)
    slice.features = touched.map(id => (doc.features ?? []).find(f => f.id === id))
  } else if (featureId !== undefined) {
    slice.features = [(doc.features ?? []).find(f => f.id === featureId)]
  }
  if (bodyId !== undefined) {
    slice.part_style = { [bodyId]: doc.part_style?.[bodyId] }
  }
  return slice
}
