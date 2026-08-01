// PURE LOGIC -- no DOM, no Three.js, no React refs.
// This file must be importable in a plain vitest test without a DOM.
//
// The single place that tells a click apart from a camera gesture. Both editors
// need the same answer and must not drift: each one's `onPointerMissed` fires on
// gestures the user aimed at the camera, and clearing the selection there is
// exactly the bug this module exists to prevent.

import { isPureClick } from '@/components/Geometry3D/pointerAbstraction'

export interface ClickGestureState {
  // Which button opened the gesture; null when no pointer-down was seen.
  readonly button: number | null
  // Screen position of the pointer-down, kept to measure the travel from.
  readonly origin: readonly [number, number] | null
  // The pointer travelled past CLICK_THRESHOLD_PX at some point in the gesture.
  readonly wasDrag: boolean
}

export const IDLE_GESTURE: ClickGestureState = { button: null, origin: null, wasDrag: false }

function travelled(origin: readonly [number, number], x: number, y: number): boolean {
  return !isPureClick(origin, [x, y])
}

export function gestureDown(button: number, x: number, y: number): ClickGestureState {
  return { button, origin: [x, y], wasDrag: false }
}

/**
 * Once a gesture is a drag it stays one. An orbit that swings out and returns to
 * within a few pixels of where it started is still an orbit, and measuring only
 * the two end points would report it as a click.
 */
export function gestureMove(state: ClickGestureState, x: number, y: number): ClickGestureState {
  if (state.origin === null || state.wasDrag) return state
  if (!travelled(state.origin, x, y)) return state
  return { ...state, wasDrag: true }
}

/**
 * Closes the gesture but keeps the verdict: the click event that decides whether
 * to deselect arrives after pointer-up, so `button` and `wasDrag` have to outlive
 * the gesture itself. A pointer-up with no matching pointer-down (the press
 * happened outside the pane) leaves nothing to judge and resets to idle.
 */
export function gestureUp(state: ClickGestureState, x: number, y: number): ClickGestureState {
  if (state.origin === null) return IDLE_GESTURE
  return {
    button: state.button,
    origin: null,
    wasDrag: state.wasDrag || travelled(state.origin, x, y),
  }
}

/**
 * The one predicate a deselect may be gated on: the left button, and no travel.
 * Camera gestures fail it on the button alone (SceneController maps LEFT to no
 * camera action, so orbit/pan/dolly are all right- or middle-button), and a
 * left-button drag such as a rubber band or a part grab fails it on the travel.
 */
export function isStationaryPrimaryClick(state: ClickGestureState): boolean {
  return state.button === 0 && !state.wasDrag
}

/** Mutable holder for the state above, for components that keep it in a ref. */
export interface ClickGestureTracker {
  readonly state: ClickGestureState
  down(button: number, x: number, y: number): void
  move(x: number, y: number): void
  // Returns the closed gesture so the caller can branch on it immediately.
  up(x: number, y: number): ClickGestureState
  reset(): void
}

export function createClickGestureTracker(): ClickGestureTracker {
  let state = IDLE_GESTURE
  return {
    get state() { return state },
    down(button, x, y) { state = gestureDown(button, x, y) },
    move(x, y) { state = gestureMove(state, x, y) },
    up(x, y) { state = gestureUp(state, x, y); return state },
    reset() { state = IDLE_GESTURE },
  }
}
