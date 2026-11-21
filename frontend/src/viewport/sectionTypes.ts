// Section plane data types, kept out of `sectionPlane.ts` so a headless store
// can name the source without pulling the module's `three` import into the
// store closure.

export type BuiltinSectionPlaneId = 'front' | 'top' | 'right'

/**
 * The section plane's two tilt angles, in radians, about the source frame's own
 * axes: pitch about `u`, then yaw about the pitched `v`. There is deliberately
 * no roll, because spinning a plane about its normal does not change the cut.
 */
export interface SectionTilt {
  pitch: number
  yaw: number
}

/** Untilted, the state every new source starts in. */
export const NO_TILT: SectionTilt = { pitch: 0, yaw: 0 }

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
