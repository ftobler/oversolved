// Section plane data types, kept out of `sectionPlane.ts` so a headless store
// can name the source without pulling the module's `three` import into the
// store closure.

export type BuiltinSectionPlaneId = 'front' | 'top' | 'right'

/**
 * The plane the user chose. `query` covers both a user-defined plane and a
 * planar face: the resolver tries the solve result's plane transform first and
 * the body face frame second, so a query that stops resolving is detectable in
 * one place.
 */
export type SectionPlaneSource =
  | { kind: 'builtin'; id: BuiltinSectionPlaneId }
  // `pickKey` is the face primitive that was clicked. Keeping it with the
  // source means a shared query still resolves to the face the user chose after
  // a re-solve, not whichever owner registered first.
  | { kind: 'query'; query: string; pickKey?: string }
