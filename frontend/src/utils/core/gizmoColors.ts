// The single source of colour for the assembly-mode triad gizmo: its arrows,
// rings, plane quads and the angle dial that grows out of a ring drag.
//
// Everything below is derived from TRIAD_COLOR or defined right next to it on
// purpose. The triad used to borrow COLOR_HOVER/COLOR_PREVIEW_EDGE from
// partColors and mix in its own greys and whites, which meant re-hueing the
// gizmo touched several files and silently dragged unrelated consumers along.
// Re-hueing it is now one edit on the line below.
//
// Not for the per-axis mate anchors (AnchorGizmos), the roll guide or the view
// cube: those are deliberately their own thing and stay out of here.

import { blendWhite } from '@/utils/core/partColors'

// The triad's own yellow. Deliberately not one of partColors' hues: it reads as
// "grabbable handle" against both the default body green and a selected body,
// which is what the gizmo has to say. If the intent ever becomes "exactly the
// colour selection is drawn in", import COLOR_SELECTED instead of retyping a
// value here, so the two cannot drift.
export const TRIAD_COLOR = '#ecad2b'

// How far an emphasised handle is lifted toward white. Enough that the handle
// under the cursor reads as picked out without becoming a second colour, which
// is the whole reason the triad is uni-hue in the first place.
const EMPHASIS_TINT = 0.45

// How far a backgrounded handle is pushed toward black. The dial's datum spoke
// and its ticks are reference marks behind the live reading, so they lose
// brightness rather than gaining a hue of their own.
const DIM_SHADE = 0.42

/**
 * Returns `hex` blended toward black by `factor` (0 = unchanged, 1 = black).
 * Takes full 6-digit `#rrggbb` only, upper or lower case: it reads channels at
 * fixed offsets, so shorthand like `#fff` yields garbage rather than throwing.
 * Same constraint as blendWhite, and the same reason it is fine here: every
 * caller passes a constant declared in this file.
 */
export function darkenHex(hex: string, factor: number): string {
  const channel = (at: number) => {
    const value = parseInt(hex.slice(at, at + 2), 16)
    return Math.max(0, Math.round(value * (1 - factor))).toString(16).padStart(2, '0')
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

/**
 * The emphasis shade: the handle under the cursor, the halo around a held plane
 * quad, and the dial's live reading while it is snapped to a tick. All three
 * mean "this is the thing in play right now", so they share one shade.
 */
export const TRIAD_COLOR_HOVER = blendWhite(TRIAD_COLOR, EMPHASIS_TINT)

/** The backgrounded shade: dial datum spoke and unlit ticks. */
export const TRIAD_COLOR_DIM = darkenHex(TRIAD_COLOR, DIM_SHADE)

// Plane quads are fills rather than line art, so they carry the hue at low
// alpha and lean on opacity, not colour, to answer hover.
export const TRIAD_PLANE_OPACITY = 0.3
export const TRIAD_PLANE_OPACITY_HOVER = 0.62

/** The dial's swept wedge: a tint over the body, never a solid. */
export const DIAL_SWEEP_OPACITY = 0.22

// Disarmed, the ticks are still drawn but faded almost out: removing them
// entirely would make the dial jump every time the cursor crosses the ring,
// while leaving them lit would advertise bearings the drag can no longer reach.
// Fading says "still there, not in play", which is exactly the state.
export const DIAL_TICK_OPACITY = 1
export const DIAL_TICK_OPACITY_DISARMED = 0.18
