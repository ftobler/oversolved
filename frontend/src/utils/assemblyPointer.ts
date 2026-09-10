// The pointer surface Stage 6d left open: it turns viewport rays into the
// manipulation-session calls assemblyStore already exposes. Everything here is
// framework-free: the viewport supplies a hit handle, a world point and a ray
// per pointer event; nothing three.js reaches this module.
//
// Three gestures, one session each:
//   plane  - slide within a plane: the one facing the camera for a body grab,
//            or a part-axis plane for a triad plane handle. Both are the same
//            drag once the plane is known, so they share the state and the move.
//   axis   - a triad arrow: slide along one world axis
//   ring   - a triad ring: swing about one world axis, pivoting on the gizmo
//
// A part carrying the instance-level `fixed` flag (not the fixed mate) still
// selects on click but never opens a session: beginPartManipulation refuses it,
// and we leave no gesture behind, so the following move/up are inert. Fixing a
// part declares it the assembly's static frame, and it is enforced again in
// setInstanceTransform: the UI is not the only guard.

import {
  closestParamOnAxis,
  intersectRayPlane,
  normalize,
  scale,
  signedAngleAbout,
  sub,
  unwrapAngle,
  type Ray,
} from '@/utils/gizmoMath'
import { datumAngle, snapArmedAtRadius, snapSwing } from '@/utils/gizmoAngleSnap'
import { isStationaryPrimaryClick, type ClickGestureState } from '@/utils/clickGesture'
import {
  createAssemblyGestureMachine,
  type GestureOutcome,
  type GestureSource,
  type PointerRef,
} from '@/utils/assemblyGesture'
import type { GizmoAxisName } from '@/utils/gizmoPickGeometry'
import type { GizmoDragState } from '@/stores/assemblyStore'
import type { Vec3 } from '@/utils/transform3d'

export type { GestureOutcome, GestureSource, PointerRef } from '@/utils/assemblyGesture'

/** The subset of assemblyStore the adapter drives. */
export interface AssemblyPointerStore {
  beginPartManipulation: (handle: string) => boolean
  // A body grab: begins a solver-driven session, capturing the grab point.
  beginBodyDrag: (handle: string, worldGrab: Vec3) => boolean
  // Where the grab point is being pulled to, in world space.
  setDragTarget: (target: Vec3) => void
  dragPartTranslate: (delta: Vec3) => void
  rotatePartGizmo: (axis: Vec3, angle: number, pivot?: Vec3) => void
  endPartManipulation: () => void
  cancelPartManipulation: () => void
  selectPart: (handle: string | null) => void
  // Ending a session clears this store-side; the adapter only ever sets it.
  setGizmoDrag: (drag: GizmoDragState | null) => void
}

export type GizmoMode = 'translate' | 'rotate' | 'plane'

/**
 * Whether the pointer-up that ended this gesture may still toggle the B-rep
 * entity under the cursor into the measurement selection.
 *
 * A release that did not belong to the gesture owns nothing, so it cannot
 * select. Beyond that, two things must never select. A gesture that began on a
 * triad handle is unambiguously a manipulation: the handle is drawn over the
 * part, so the face behind it is not what the user pointed at, however short the
 * gesture was. And a gesture that moved the part asked for a re-solve, which
 * drops the selection (the keys are positional) a few frames later -- selecting
 * there only makes a highlight that silently disappears.
 *
 * What is left is a body grab that never moved: a plain click on the part, which
 * selects exactly as it would with no session open.
 */
export function gestureAllowsSelect(outcome: GestureOutcome): boolean {
  return outcome.owned && outcome.source !== 'gizmo' && !outcome.moved
}

/**
 * Whether a click that hit no geometry may clear the assembly selection.
 *
 * Camera manipulation must never cost the user their selection, and it very
 * nearly always looks like a miss: the camera is driven with the right button
 * (SceneController maps LEFT to no camera action at all), and Chrome on Linux
 * fires `contextmenu` on the pointer-DOWN that opens the orbit. R3F counts
 * `contextmenu` as a click event, so it reaches onPointerMissed with a travel
 * distance of zero -- its own `delta <= 2` guard cannot catch it, because at
 * that instant the pointer genuinely has not moved yet.
 *
 * So the guard is on the gesture, not the distance: only a stationary LEFT
 * click is a deselect. A gesture still in flight (nothing released yet) is
 * judged on the button it opened with, which is what rejects the orbit.
 */
export function missClearsSelection(gesture: ClickGestureState, adapterActive: boolean): boolean {
  if (adapterActive) return false  // a part drag owns the pointer; its release is not a deselect
  return isStationaryPrimaryClick(gesture)
}

type Gesture =
  // A body grab: solver-driven. The move feeds the cursor's world position (the
  // hit on the grab plane) to the solver as the target for the grab point, and
  // the SOLVED pose drives the part. Distinct from `plane` (a triad handle),
  // which drives the part geometrically by a translation delta.
  | { kind: 'bodyDrag'; grab: Vec3; normal: Vec3 }
  | { kind: 'plane'; grab: Vec3; normal: Vec3 }
  | { kind: 'axis'; axis: Vec3; origin: Vec3; startParam: number }
  // `swing` is the running total since pointer-down, the one piece of gesture
  // state carried frame to frame: the measured angle alone tops out at a half
  // turn, so it is unwrapped against this to let a drag keep going round.
  // It is the RAW swing, never the snapped one: unwrapping resolves each new
  // reading against where the cursor was, and resolving it against a tick
  // instead would let a snap capture the drag.
  | {
      kind: 'ring'
      axis: Vec3
      axisName: GizmoAxisName
      origin: Vec3
      startArm: Vec3
      swing: number
      datum: number
    }

export interface AssemblyPointerAdapter {
  /**
   * Records the opening pointer and starts its click origin. A false return
   * means a second pointer arrived while one was already down, so the caller
   * must not open a session for it.
   */
  pointerDown: (pointer: PointerRef, x: number, y: number) => boolean
  // Advances the click tracker; does not touch the session or the ray math.
  pointerMove: (x: number, y: number) => void
  // Abandons the gesture only when the cancelling pointer is the opener, so a
  // secondary pointer going away cannot end the primary's drag.
  pointerCancel: (pointer: PointerRef) => void
  // Selects the part; opens a drag session unless it is fixed.
  onBodyPointerDown: (handle: string, grab: Vec3, viewNormal: Vec3, pointer: PointerRef) => boolean
  /**
   * `axis` is the world slide/swing axis, or for `plane` the plane's normal.
   * `axisName` names the same axis in part-local terms, for the drag state the
   * triad renders from. `reference` is the axis's `u` companion in world space:
   * a ring measures the grab bearing from it, and everything else ignores it.
   * `pointer` is the pointer that opened the handle, so the machine can refuse
   * one it does not own.
   */
  onGizmoPointerDown: (
    handle: string,
    mode: GizmoMode,
    axisName: GizmoAxisName,
    axis: Vec3,
    reference: Vec3,
    origin: Vec3,
    ray: Ray,
    pointer: PointerRef,
  ) => boolean
  /**
   * `gizmoWorldScale` is the world size of one gizmo unit right now, which the
   * ring branch needs to know where the drawn circle is (see snapArmedAtRadius).
   * It is read per move rather than captured at pointer-down so a camera dolly
   * mid-drag cannot leave the gate and the visible ring disagreeing. Omitting it
   * leaves snapping armed: a caller with no camera to measure has no business
   * disarming a feature the user asked for.
   */
  onPointerMove: (ray: Ray, gizmoWorldScale?: number) => void
  // Commits the session when the release owns the gesture. An unowned release
  // is inert and the session survives it. The release position closes the click
  // tracker, so the travel from the down to the up is measured even when no
  // pointermove landed between them.
  onPointerUp: (pointer: PointerRef, x: number, y: number) => GestureOutcome
  cancel: () => void
  isActive: () => boolean
  readonly clickState: ClickGestureState
}

export function createAssemblyPointerAdapter(store: AssemblyPointerStore): AssemblyPointerAdapter {
  // The math state for one session, set by the open transitions and cleared by
  // the owned release or cancel. `moved` lives in the machine now: it counts
  // only moves that reached the store, so a pointermove landing back on the
  // grab point drags by nothing and must leave a click a click.
  let gesture: Gesture | null = null
  const machine = createAssemblyGestureMachine()

  const openGesture = (g: Gesture, from: GestureSource, pointer: PointerRef): boolean => {
    if (!machine.open(from, pointer)) {
      // A pointer the machine refused cannot own the session the store just
      // opened, so unwind it rather than leaving a drag nobody is holding.
      store.cancelPartManipulation()
      return false
    }
    gesture = g
    return true
  }

  const onBodyPointerDown = (handle: string, grab: Vec3, viewNormal: Vec3, pointer: PointerRef): boolean => {
    store.selectPart(handle)
    if (!store.beginBodyDrag(handle, grab)) return false
    return openGesture({ kind: 'bodyDrag', grab, normal: viewNormal }, 'body', pointer)
  }

  const onGizmoPointerDown = (
    handle: string,
    mode: GizmoMode,
    axisName: GizmoAxisName,
    rawAxis: Vec3,
    reference: Vec3,
    origin: Vec3,
    ray: Ray,
    pointer: PointerRef,
  ): boolean => {
    // closestParamOnAxis measures in unit-axis steps, so the slide delta below
    // is only a distance if the axis it scales is unit too.
    const axis = normalize(rawAxis)
    if (!axis) return false
    if (!store.beginPartManipulation(handle)) return false

    if (mode === 'translate') {
      const startParam = closestParamOnAxis(ray, origin, axis)
      // Sighting straight down a translate arrow gives no usable slide measure;
      // abandon the session rather than open one that maps every move to NaN.
      if (startParam === null) {
        store.cancelPartManipulation()
        return false
      }
      store.setGizmoDrag({ kind: 'axis', axis: axisName })
      return openGesture({ kind: 'axis', axis, origin, startParam }, 'gizmo', pointer)
    }

    // Both remaining modes read the pointer against the plane through the gizmo
    // normal to `axis`; a ray grazing that plane gives neither a swing arm nor a
    // grab point, so abandon rather than open a session that measures nothing.
    const hit = intersectRayPlane(ray, origin, axis)
    if (!hit) {
      store.cancelPartManipulation()
      return false
    }

    if (mode === 'plane') {
      // The grab is on the plane already, so the drag needs no other anchor:
      // every later hit lands on the same plane and the difference is the move.
      store.setGizmoDrag({ kind: 'plane', axis: axisName })
      return openGesture({ kind: 'plane', grab: hit, normal: axis }, 'gizmo', pointer)
    }

    const startArm = sub(hit, origin)
    const datum = datumAngle(signedAngleAbout(axis, reference, startArm))
    // A swing of zero is a multiple of the step, so the dial starts on a tick.
    // Armed by construction: the pointer-down resolved on the ring's own grab
    // region, which is the boundary the gate is drawn at.
    store.setGizmoDrag({ kind: 'ring', axis: axisName, datum, swing: 0, snapped: true, snapArmed: true })
    return openGesture({ kind: 'ring', axis, axisName, origin, startArm, swing: 0, datum }, 'gizmo', pointer)
  }

  const onPointerMove = (ray: Ray, gizmoWorldScale?: number): void => {
    if (!gesture) return

    if (gesture.kind === 'bodyDrag') {
      const hit = intersectRayPlane(ray, gesture.grab, gesture.normal)
      if (!hit) return
      // A hit back on the grab point is a zero-move click: it must not ask for a
      // solve, so the release stays a plain select.
      if (hit[0] === gesture.grab[0] && hit[1] === gesture.grab[1] && hit[2] === gesture.grab[2]) return
      machine.markMoved()
      store.setDragTarget(hit)
      return
    }

    if (gesture.kind === 'plane') {
      const hit = intersectRayPlane(ray, gesture.grab, gesture.normal)
      if (!hit) return
      const delta = sub(hit, gesture.grab)
      if (delta[0] !== 0 || delta[1] !== 0 || delta[2] !== 0) machine.markMoved()
      store.dragPartTranslate(delta)
      return
    }

    if (gesture.kind === 'axis') {
      const param = closestParamOnAxis(ray, gesture.origin, gesture.axis)
      if (param === null) return
      if (param !== gesture.startParam) machine.markMoved()
      store.dragPartTranslate(scale(gesture.axis, param - gesture.startParam))
      return
    }

    const hit = intersectRayPlane(ray, gesture.origin, gesture.axis)
    if (!hit) return
    const arm = sub(hit, gesture.origin)
    const measured = signedAngleAbout(gesture.axis, gesture.startArm, arm)
    gesture.swing = unwrapAngle(measured, gesture.swing)
    // How far out the cursor is arms or disarms snapping wholesale: inside the
    // ring it clicks onto the ticks, outside it the user has pulled away for
    // fine control and no angle may be touched. The arm is what the angle was
    // just measured from, so the gate and the swing cannot sample different
    // points. Arming does not disturb `swing`, which stays the raw unwrapped
    // total whichever side of the ring the cursor is on.
    const armed = gizmoWorldScale === undefined
      || snapArmedAtRadius(Math.hypot(arm[0], arm[1], arm[2]), gizmoWorldScale)
    const snap = snapSwing(gesture.swing, armed)
    // `moved` follows the angle the part receives, not the cursor's: a wobble
    // small enough to be pulled back onto zero moves nothing, and must leave a
    // click a click.
    if (snap.angle !== 0) machine.markMoved()
    store.setGizmoDrag({
      kind: 'ring',
      axis: gesture.axisName,
      datum: gesture.datum,
      swing: snap.angle,
      snapped: snap.snapped,
      snapArmed: armed,
    })
    store.rotatePartGizmo(gesture.axis, snap.angle, gesture.origin)
  }

  const onPointerUp = (pointer: PointerRef, x: number, y: number): GestureOutcome => {
    const outcome = machine.pointerUp(pointer, x, y)
    // A release from another button or pointer owns nothing: it must not end a
    // live drag, so the session stays open until the opening pointer releases.
    if (!outcome.owned) return outcome
    if (gesture) {
      gesture = null
      store.endPartManipulation()
    }
    return outcome
  }

  const cancel = (): void => {
    machine.cancel()
    gesture = null
    store.cancelPartManipulation()
  }

  return {
    pointerDown: machine.pointerDown,
    pointerMove: machine.pointerMove,
    pointerCancel: machine.pointerCancel,
    onBodyPointerDown,
    onGizmoPointerDown,
    onPointerMove,
    onPointerUp,
    cancel,
    isActive: machine.isActive,
    get clickState() { return machine.clickState },
  }
}
