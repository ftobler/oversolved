// The section view's viewer state: a momentary inspection tool, not part of
// the document.
//
// Nothing here is persisted, goes through a Mutation or records an undo entry.
// The section is the pair of glasses the user looks through, like the view
// options beside it, and a stale one after a reload would be a confusing
// surprise rather than a restore.
import { create } from 'zustand'
import type { SectionPlaneSource } from '@/viewport/sectionPlane'

export interface SectionState {
  enabled: boolean
  plane: SectionPlaneSource
  // Distance along the plane's normal, world units.
  offset: number
  // Keep the other half-space.
  flipped: boolean
  // Why an enabled section turned itself off. Set when the picked plane or face
  // stops resolving after a solve; shown in the dropdown so the row going
  // unchecked is not silent.
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
  setFlipped: (flipped: boolean) => void
  toggleFlipped: () => void
  setPicking: (picking: boolean) => void
  setPickError: (error: string | null) => void
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
  flipped: false,
  disabledReason: null,
  pickError: null,
  picking: false,
  resolved: false,
  capturing: false,
} satisfies Pick<SectionState, 'enabled' | 'plane' | 'offset' | 'flipped' | 'disabledReason' | 'pickError' | 'picking' | 'resolved' | 'capturing'>

export const SECTION_SOURCE_GONE_REASON = 'Section off: the picked plane or face no longer resolves after the solve.'
export const SECTION_FACE_NOT_FLAT_REASON = 'Pick a flat face or a plane.'

export const useSectionStore = create<SectionState>((set, get) => ({
  ...DEFAULT_SECTION_STATE,

  setEnabled: (on) => set({ enabled: on, disabledReason: null, picking: false, pickError: null, resolved: false }),

  setPlane: (plane) => set({ plane, disabledReason: null, pickError: null }),

  setOffset: (value) => {
    // A non-finite offset would place the plane at NaN and silently clip the
    // whole scene away; hold the previous value instead.
    if (!Number.isFinite(value)) return
    set({ offset: value })
  },

  setFlipped: (flipped) => set({ flipped }),

  toggleFlipped: () => set(s => ({ flipped: !s.flipped })),

  setPicking: (picking) => set({ picking, pickError: picking ? null : get().pickError }),

  setPickError: (pickError) => set({ pickError }),

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

  reset: () => set({ ...DEFAULT_SECTION_STATE }),
}))
