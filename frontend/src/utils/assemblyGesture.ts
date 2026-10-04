// PURE LOGIC -- no DOM, no Three.js, no React, no store.
//
// One owner for the assembly gizmo/body drag lifecycle. Before this module the
// lifecycle was split across an adapter closure, a React state flag, a click
// tracker ref and the browser's pointer capture, and two slices had already
// drifted: a right-button release committed a left drag, and Escape left the
// click tracker open so the delayed release selected the face behind the ring.
// The machine makes both states unrepresentable instead of defending against
// them at each call site.
//
// It owns the opening pointer, the phase, the click tracker, the source and the
// moved flag, and nothing else. The ray math and the store writes stay in
// utils/assemblyPointer.ts, which composes this machine.

import { createClickGestureTracker, type ClickGestureState } from '@/utils/clickGesture'

export interface PointerRef {
  id: number
  button: number
}

/** Which pointer-down opened the session: the part itself, or a triad handle. */
export type GestureSource = 'body' | 'gizmo'

export type GesturePhase = 'idle' | 'down' | 'dragging'

export interface GestureOutcome {
  // True only when this release belonged to the gesture (matched pointer and
  // button). A release that does not match is inert and ends nothing.
  owned: boolean
  source: GestureSource | null
  moved: boolean
}

// Shared and frozen: an unowned release must never be mutated into a commit.
const REJECTED: GestureOutcome = Object.freeze({ owned: false, source: null, moved: false })

export interface AssemblyGestureMachine {
  // Records the first pointer and starts its click origin. Returns false for a
  // second pointer while one is down, so multi-touch cannot hijack a live drag.
  pointerDown: (pointer: PointerRef, x: number, y: number) => boolean
  // Whether a pointer may open a session: true for the recorded opener, and for
  // any pointer while none is recorded (the capture-before-pointerDown window).
  // Lets the adapter refuse a foreign pointer before it touches the store.
  canOpen: (pointer: PointerRef) => boolean
  // Confirms the geometry layer that just opened belongs to the opening pointer.
  // Refuses a pointer that is not the opener once one is recorded.
  open: (source: GestureSource, pointer: PointerRef) => boolean
  markMoved: () => void
  // Advances the click tracker only for the recorded opener, so a second
  // pointer moving while the opener is held cannot latch the opener's travel.
  pointerMove: (pointer: PointerRef, x: number, y: number) => void
  // The only transition that yields `owned: true`. Requires the opener's pointer
  // id and button, then closes the click tracker and clears the opener. Any
  // other release is inert and leaves the gesture open.
  pointerUp: (pointer: PointerRef, x: number, y: number) => GestureOutcome
  // Cancels only when the pointer is the opener, so a secondary pointer going
  // away cannot abandon the primary's gesture. Returns whether it cancelled, so
  // the caller can unwind the store session it owns.
  pointerCancel: (pointer: PointerRef) => boolean
  // The single abandonment transition. Escape, pointercancel and unmount all
  // land here, so none of them can forget a slice of the state.
  cancel: () => void
  isActive: () => boolean
  readonly phase: GesturePhase
  readonly clickState: ClickGestureState
  readonly source: GestureSource | null
  readonly moved: boolean
}

export function createAssemblyGestureMachine(): AssemblyGestureMachine {
  const click = createClickGestureTracker()
  let opener: PointerRef | null = null
  let source: GestureSource | null = null
  let moved = false

  const cancel = (): void => {
    click.reset()
    opener = null
    source = null
    moved = false
  }

  const pointerDown = (pointer: PointerRef, x: number, y: number): boolean => {
    // First wins. A second touch joining a live gesture is ignored wholesale,
    // not merged, or the two pointers would take turns steering one session.
    if (opener) return false
    opener = { id: pointer.id, button: pointer.button }
    moved = false
    click.down(pointer.id, pointer.button, x, y)
    return true
  }

  // Id-only by design: a session opens in the capture phase, before the
  // wrapper's pointerDown has recorded the button, so there is no button to
  // compare against yet. The button is enforced on the release, which is where
  // a mismatch could actually commit the wrong thing.
  const canOpen = (pointer: PointerRef): boolean => !opener || opener.id === pointer.id

  const open = (from: GestureSource, pointer: PointerRef): boolean => {
    if (!canOpen(pointer)) return false
    source = from
    moved = false
    return true
  }

  const markMoved = (): void => { moved = true }

  const pointerMove = (pointer: PointerRef, x: number, y: number): void => {
    click.move(pointer.id, x, y)
  }

  const pointerUp = (pointer: PointerRef, x: number, y: number): GestureOutcome => {
    if (!opener || pointer.id !== opener.id || pointer.button !== opener.button) return REJECTED
    click.up(pointer.id, x, y)
    opener = null
    const outcome: GestureOutcome = { owned: true, source, moved }
    source = null
    moved = false
    return outcome
  }

  const pointerCancel = (pointer: PointerRef): boolean => {
    if (!opener || opener.id !== pointer.id) return false
    cancel()
    return true
  }

  return {
    pointerDown,
    canOpen,
    open,
    markMoved,
    pointerMove,
    pointerUp,
    pointerCancel,
    cancel,
    isActive: () => source !== null,
    get phase(): GesturePhase {
      if (opener === null) return 'idle'
      return moved ? 'dragging' : 'down'
    },
    get clickState(): ClickGestureState {
      return click.state
    },
    get source(): GestureSource | null { return source },
    get moved(): boolean { return moved },
  }
}
