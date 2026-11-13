// The typeRestriction vocabulary of an ancestry query, classified by the
// geometric kind it names. Leaf module on purpose: the document loader reads
// these predicates and must not pull the OCC adapter (or its embind types) into
// the load path. `occ/primitives` re-exports them for its existing consumers.

/** The face surface kinds plus the parent `face` restriction. */
export type SurfaceType = 'flatface' | 'cylinderface' | 'coneface' | 'sphereface' | 'torusface' | 'face'

// Every typeRestriction that names a face, as data. This is the one copy of the
// face vocabulary as a list: `isFaceRestriction` below is the predicate every
// consumer calls, and a subset list (the analytic-surface set delete face can
// extend) filters this array instead of hand-copying kinds.
export const FACE_RESTRICTION_TYPES: readonly SurfaceType[] = [
  'flatface', 'cylinderface', 'coneface', 'sphereface', 'torusface', 'face',
]

// One shared copy so every consumer agrees on what counts as a face (g2-M2): a
// partial hand list made a cone, sphere or torus pick resolve nothing on the
// fillet and projection paths.
export function isFaceRestriction(tr: string | null): boolean {
  return tr !== null && (FACE_RESTRICTION_TYPES as readonly string[]).includes(tr)
}

export function isEdgeRestriction(tr: string | null): boolean {
  return tr === 'edge' || tr === 'straightedge'
}
