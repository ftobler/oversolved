import type { PartDoc, Mutation, PartFeature } from '@/types/cad'

// The mutation types the color preview can produce. Suppression is scoped to
// these: while a preview is open any OTHER mutation is an escape that
// auto-commits the preview and then pushes normally, so a sketch edit
// mid-preview is never swallowed and destroyed by a later cancel. A suppressed
// feature session does not share this scope: it owns the doc and swallows
// every mutation until commit or cancel.
export const PREVIEW_SCOPE = new Set<Mutation['type']>([
  'set_part_color',
  'set_part_transparency',
  'set_part_metalness',
  'set_part_roughness',
  'set_part_transmission',
])

// The kinds whose pruned solve result is the ONLY thing that can re-render them
// after a failing solve: they produce body geometry with no `initial`-style doc
// fallback (the plan's BREP/import scope). A sketch renders from `initial`
// (Viewport/index.tsx), a plane solves trivially, a variable carries no
// geometry, so retaining their snapshots would only consume the stash cap.
export const NO_FALLBACK_BREP_KINDS = new Set([
  'extrude', 'revolve', 'sweep',
  'fillet', 'chamfer',
  'shell', 'delete_face',
  'boolean', 'hole',
  'array', 'circular_array',
  'transform', 'mirror',
  'delete_body', 'import_step',
])

// The kind of the named feature in `doc`, or undefined when absent. The stash
// gate needs the kind of a feature about to be pruned; both funnels run before
// the pre-mutation doc is replaced, so it still carries the feature.
export function featureKindOf(doc: PartDoc | null, featureId: string): string | undefined {
  return (doc?.features ?? []).find(f => f.id === featureId)?.kind
}

// Whole-doc change test for the edit-session commit. Three fields are excluded,
// each written by the solve rather than by the user:
// - part_style: reconcilePartStyle fabricates entries there during a solve,
//   which would manufacture an edit out of nothing.
// - initial: the solver write-back (applyGeometryToFeature) re-bakes the solved
//   geometry of every sketch on each solve. A suppressed session is only ever
//   open on a non-sketch feature (a sketch edit runs its own unsuppressed
//   session and keeps one entry per action), so an `initial` change inside one
//   can only have come from the write-back. Counting it would push an aggregate
//   entry that restores a doc with no user change in it, and undo would then
//   re-solve to re-derive the same geometry, which reads as a dead step.
// - rollback: it is pinned during an edit (the mirror only runs when
//   editingFeatureId is null), so it can never be a user change inside a session.
// stringify is read-only, so the excluded keys are dropped by destructuring the
// rest; that keeps the remaining key order and every nested value by reference,
// and a whole-doc deep clone would only be discarded. `initial` lives one level
// down on the features, which are shared by reference with the doc, so the strip
// copies each feature object instead of deleting the key off the original.
export function docDiffersForSession(a: PartDoc, b: PartDoc): boolean {
  return JSON.stringify(stripSolveWritten(a)) !== JSON.stringify(stripSolveWritten(b))
}

function stripSolveWritten(doc: PartDoc): Record<string, unknown> {
  const { part_style: _partStyle, rollback: _rollback, features, ...rest } = doc
  return {
    ...rest,
    ...(features && { features: features.map(stripSolvedGeometry) }),
  }
}

const stripSolvedGeometry = (feature: PartFeature): Record<string, unknown> => {
  // Only a sketch carries solve-written `initial`; other kinds pass through.
  if (feature.kind !== 'sketch') return feature
  const { initial: _initial, ...rest } = feature
  return rest
}

// The commit label for a preview apply. The color popover is the only preview
// producer and it edits per-body material fields, so the diff is against the
// pre-preview doc's part_style; the popover always applies `set_part_color` on
// Apply even when only a slider moved, so naming what actually changed is more
// honest than reusing that mutation. Returns null when nothing in part_style
// changed, letting the caller fall back to the mutation it was handed.
export function previewMutationFor(original: PartDoc, current: PartDoc): Mutation | null {
  const before = original.part_style ?? {}
  const after = current.part_style ?? {}
  const bodyIds = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const bodyId of bodyIds) {
    const a = (before[bodyId] ?? {}) as Record<string, unknown>
    const b = (after[bodyId] ?? {}) as Record<string, unknown>
    const fields = Object.keys({ ...a, ...b }).filter(f => a[f] !== b[f])
    if (fields.length > 0) changed.push(`edit ${bodyId}: ${fields.join(', ')}`)
  }
  if (changed.length === 0) return null
  return { type: 'preview_commit', description: changed.join('; ') }
}
