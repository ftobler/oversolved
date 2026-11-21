// The section view's viewer state: a momentary inspection tool, not part of
// the document.
//
// Nothing here is persisted, goes through a Mutation or records an undo entry.
// The section is the pair of glasses the user looks through, like the view
// options beside it, and a stale one after a reload would be a confusing
// surprise rather than a restore.
import { create } from 'zustand'
import { NO_TILT, type SectionPlaneSource, type SectionTilt } from '@/viewport/sectionTypes'
import { clampSectionTilt } from '@/viewport/sectionTilt'

export interface SectionState {
  enabled: boolean
  plane: SectionPlaneSource
  // Distance along the SOURCE normal, world units. The tilt pivots about this
  // point, so the Offset box keeps meaning the same thing once the plane is
  // turned.
  offset: number
  // Rotation of the plane about its source frame's own axes, radians. Pitch
  // turns about `u`, then yaw about the pitched `v`; there is no roll.
  tilt: SectionTilt
  // Keep the other half-space.
  flipped: boolean
  // Why an enabled section turned itself off. Set when the picked plane or face
  // stops resolving after a solve; shown in the section card and the dropdown
  // note so the row going unchecked is not silent.
  disabledReason: string | null
  // Why the last armed pick was refused (a curved face, for instance). Cleared
  // when the pick is re-armed or succeeds.
  pickError: string | null
  // The next face or plane pick in the viewport names the section plane.
  picking: boolean
  // Derived: the enabled source resolves right now. Kept in the store so every
  // body can subscribe to one boolean instead of the moving plane data.
  resolved: boolean
  // True while a thumbnail capture is in flight. Section-only furniture (the
  // plane outline and drag arrow) hides itself, or a saved preview would carry
  // a cut-away guide into the document tile.
  capturing: boolean

  setEnabled: (on: boolean) => void
  setPlane: (plane: SectionPlaneSource) => void
  setOffset: (value: number) => void
  // The tilt is clamped to the cone where the plane still cuts along its own
  // normal (see clampSectionTilt), so no caller can park the section at 90.
  setTilt: (tilt: SectionTilt) => void
  resetTilt: () => void
  setFlipped: (flipped: boolean) => void
  toggleFlipped: () => void
  setPicking: (picking: boolean) => void
  setPickError: (error: string | null) => void
  // Abandon an armed pick without changing the current section plane.
  cancelPicking: () => void
  setResolved: (resolved: boolean) => void
  setCapturing: (capturing: boolean) => void
  // Turn off because the source no longer resolves, with a reason to show.
  disable: (reason: string) => void
  reset: () => void
}

export const DEFAULT_SECTION_STATE = {
  enabled: false,
  plane: { kind: 'builtin', id: 'front' } as SectionPlaneSource,
  offset: 0,
  tilt: NO_TILT,
  flipped: false,
  disabledReason: null,
  pickError: null,
  picking: false,
  resolved: false,
  capturing: false,
} satisfies Pick<SectionState, 'enabled' | 'plane' | 'offset' | 'tilt' | 'flipped' | 'disabledReason' | 'pickError' | 'picking' | 'resolved' | 'capturing'>

export const SECTION_SOURCE_GONE_REASON = 'Section off: the picked plane or face no longer resolves after the solve.'
export const SECTION_FACE_NOT_FLAT_REASON = 'Pick a flat face or a plane.'
export const SECTION_PICK_MISS_REASON = 'Click a flat face or a reference plane.'
export const SECTION_PICK_HINT = 'Click a flat face or a reference plane in the viewport.'
// The assembly resolves no face or plane frames for a section, so its card
// offers the builtin planes and says where the pick lives instead of arming
// one nothing would consume.
export const SECTION_PICK_UNAVAILABLE_NOTE = 'Use Front, Top or Right here; picking a face or plane is a part-editor action.'

/**
 * Whether the section card has anything to show. The card itself and the
 * assembly's right-column predicate both read this, so the column cannot stay
 * mounted for a card that draws nothing (or drop one that does).
 */
export function sectionCardVisible(
  state: Pick<SectionState, 'enabled' | 'disabledReason' | 'capturing'>,
): boolean {
  return !state.capturing && (state.enabled || state.disabledReason !== null)
}

export const useSectionStore = create<SectionState>((set, get) => ({
  ...DEFAULT_SECTION_STATE,

  setEnabled: (on) => set({ enabled: on, disabledReason: null, picking: false, pickError: null, resolved: false }),

  // A new source starts untilted: the old angles were counted from the old
  // frame's axes and would point the new plane somewhere arbitrary.
  setPlane: (plane) => set({ plane, tilt: { ...NO_TILT }, disabledReason: null, pickError: null }),

  setOffset: (value) => {
    // A non-finite offset would place the plane at NaN and silently clip the
    // whole scene away; hold the previous value instead.
    if (!Number.isFinite(value)) return
    set({ offset: value })
  },

  setTilt: (tilt) => {
    // A non-finite angle would turn the plane's normal into NaN and clip the
    // whole scene away; hold the previous pose instead, as setOffset does.
    if (!Number.isFinite(tilt.pitch) || !Number.isFinite(tilt.yaw)) return
    set({ tilt: clampSectionTilt(tilt) })
  },

  resetTilt: () => set({ tilt: { ...NO_TILT } }),

  setFlipped: (flipped) => set({ flipped }),

  toggleFlipped: () => set(s => ({ flipped: !s.flipped })),

  setPicking: (picking) => set({ picking, pickError: picking ? null : get().pickError }),

  setPickError: (pickError) => set({ pickError }),

  cancelPicking: () => set({ picking: false, pickError: null }),

  setResolved: (resolved) => {
    if (get().resolved === resolved) return
    set({ resolved })
  },

  setCapturing: (capturing) => {
    if (get().capturing === capturing) return
    set({ capturing })
  },

  disable: (reason) => {
    if (!get().enabled && get().disabledReason === reason) return
    set({ enabled: false, disabledReason: reason, picking: false, resolved: false })
  },

  reset: () => set({ ...DEFAULT_SECTION_STATE, tilt: { ...NO_TILT } }),
}))
