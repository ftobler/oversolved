// One hover/click decision for the assembly viewport, and the two framings that
// consume it.
//
// Hover and click used to resolve over different layer sets and each hand-split
// the gizmo handle off the top hit, agreeing only by coincidence (the gizmo
// capture gesture and layer priority). The part editor instead funnels both
// framings through one `computeHighlight`. This module is the assembly's
// equivalent decision half: both callers ask the same function what the pixel
// names, so a gizmo handle can never occlude an entity for one and not the
// other.
//
// Pure: no store, no three.js, no React.

import { GIZMO_HANDLE_LAYER_NAME } from '@/picking'

export interface AssemblyHit {
  entityKey: string
  layer: string
}

export interface HitDecision {
  // The triad handle under the cursor, if it is the topmost hit.
  gizmoHandle: string | null
  // The B-rep/builtin entity the pixel names, or null when a gizmo occludes it.
  // Hover and click resolve this identically today; both read it directly rather
  // than through two names, so a future divergence has to be authored here.
  entityKey: string | null
}

/**
 * The ONE decision. Both hover and click ask this, so they cannot disagree. A
 * gizmo handle outranks every entity (it is drawn on top), and when it wins the
 * entity key is null: the entity behind the handle must not be selectable even
 * if no gesture claimed the pointer-down.
 */
export function decideAssemblyHit(hits: readonly AssemblyHit[]): HitDecision {
  const first = hits[0]
  if (!first) return { gizmoHandle: null, entityKey: null }
  if (first.layer === GIZMO_HANDLE_LAYER_NAME) {
    return { gizmoHandle: first.entityKey, entityKey: null }
  }
  return { gizmoHandle: null, entityKey: first.entityKey }
}

