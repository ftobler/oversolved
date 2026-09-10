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

const REJECTED: GestureOutcome = { owned: false, source: null, moved: false }

export interface AssemblyGestureMachine {
  // Records the first pointer and starts its click origin. Returns false for a
  // second pointer while one is down, so multi-touch cannot hijack a live drag.
  pointerDown: (pointer: PointerRef, x: number, y: number) => boolean
  // Confirms the geometry layer that just opened belongs to the opening pointer.
  // Refuses a pointer that is not the opener once one is recorded.
  open: (source: GestureSource, pointer: PointerRef) => boolean
  markMoved: () => void
  pointerMove: (x: number, y: number) => void
  // The only transition that yields `owned: true`. Requires the opener's pointer
  // id and button, then closes the click tracker and clears the opener. Any
  // other release is inert and leaves the gesture open.
  pointerUp: (pointer: PointerRef, x: number, y: number) => GestureOutcome
  // Cancels only when the pointer is the opener, so a secondary pointer going
  // away cannot abandon the primary's gesture.
  pointerCancel: (pointer: PointerRef) => void
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
    click.down(pointer.button, x, y)
    return true
  }

  const open = (from: GestureSource, pointer: PointerRef): boolean => {
    // The viewport opens a gizmo session in the CAPTURE phase, before the
    // wrapper's pointerDown records the opener later in the same native event.
    // So with no opener yet this is the first pointer and is accepted; once an
    // opener is recorded, only that pointer may open.
    if (opener && opener.id !== pointer.id) return false
    source = from
    moved = false
    return true
  }

  const markMoved = (): void => { moved = true }

  const pointerMove = (x: number, y: number): void => { click.move(x, y) }

  const pointerUp = (pointer: PointerRef, x: number, y: number): GestureOutcome => {
    if (!opener || pointer.id !== opener.id || pointer.button !== opener.button) return REJECTED
    click.up(x, y)
    opener = null
    const outcome: GestureOutcome = { owned: true, source, moved }
    source = null
    moved = false
    return outcome
  }

  const pointerCancel = (pointer: PointerRef): void => {
    if (!opener || opener.id !== pointer.id) return
    cancel()
  }

  return {
    pointerDown,
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
