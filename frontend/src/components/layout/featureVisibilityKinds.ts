// The visibility eye is a per-kind decision, not a hand-written `||` chain in
// the tree. Every kind in FEATURE_SCHEMA_BY_KIND gets an eye unless the table
// records why not, so a new kind cannot silently arrive without one: the
// Record<FeatureKind, ...> tether fails the build, and the coverage test
// compares the table against the schema so a kind added to only one side fails
// too.
//
// What the eye does depends on the kind, and the body renderer decides that
// from the body's `created_by` rather than this table: a sketch-class feature
// or plane hides its own reference overlay, and any feature that made bodies
// hides them (utils/bodyRender.ts). The tree only needs to know whether the
// row offers the control.
import type { FeatureKind } from '@/types/cad'

export interface FeatureVisibilityRule {
  // Whether the tree row offers the eye.
  toggle: boolean
  // Why a kind has no eye. Required when toggle is false, so an exclusion can
  // never be an undocumented table edit.
  reason?: string
}

export const FEATURE_VISIBILITY_BY_KIND = {
  // The origin is the world datum: sketches and mates pin to it, and the
  // viewport guarantees its triad is drawn in every mode on top of everything
  // (OriginMarker). `applySetFeatureVisibility` would technically hide it, and
  // that is exactly why the rule lives here: the tree must not offer a control
  // that breaks the always-drawn datum guarantee, and hiding it would reveal
  // nothing anyway.
  origin: {
    toggle: false,
    reason: 'the origin is the world datum every sketch and mate pins to, and the viewport guarantees its triad is drawn in every mode on top of everything; a tree eye would break that guarantee and hiding it reveals nothing',
  },
  sketch: { toggle: true },
  plane: { toggle: true },
  extrude: { toggle: true },
  revolve: { toggle: true },
  sweep: { toggle: true },
  fillet: { toggle: true },
  chamfer: { toggle: true },
  shell: { toggle: true },
  move_face: { toggle: true },
  delete_face: { toggle: true },
  boolean: { toggle: true },
  pattern: { toggle: true },
  delete_body: { toggle: true },
  hole: { toggle: true },
  transform: { toggle: true },
  mirror: { toggle: true },
  split: { toggle: true },
  variable: { toggle: true },
  helix: { toggle: true },
  import_step: { toggle: true },
} as const satisfies Record<FeatureKind, FeatureVisibilityRule>

/** Whether a tree row of `kind` offers the visibility toggle. Own-property
 *  lookup, so a stray kind like `constructor` reads as no decision rather than
 *  a prototype member. */
export function hasFeatureVisibilityToggle(kind: string | undefined): boolean {
  if (kind === undefined) return false
  if (!Object.prototype.hasOwnProperty.call(FEATURE_VISIBILITY_BY_KIND, kind)) return false
  return FEATURE_VISIBILITY_BY_KIND[kind as FeatureKind].toggle
}
