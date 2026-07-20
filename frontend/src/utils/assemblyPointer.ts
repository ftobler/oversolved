// The pointer surface Stage 6d left open: it turns viewport rays into the
// manipulation-session calls assemblyStore already exposes. Everything here is
// framework-free — the viewport supplies a hit handle, a world point and a ray
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
import type { GizmoAxisName } from '@/utils/gizmoPickGeometry'
import type { GizmoDragState } from '@/stores/assemblyStore'
import type { Vec3 } from '@/utils/transform3d'

/** The subset of assemblyStore the adapter drives. */
export interface AssemblyPointerStore {
  beginPartManipulation: (handle: string) => boolean
  dragPartTranslate: (delta: Vec3) => void
  rotatePartGizmo: (axis: Vec3, angle: number, pivot?: Vec3) => void
  endPartManipulation: () => void
  cancelPartManipulation: () => void
  setSelectedPartHandle: (handle: string | null) => void
  /** Ending a session clears this store-side; the adapter only ever sets it. */
  setGizmoDrag: (drag: GizmoDragState | null) => void
}

export type GizmoMode = 'translate' | 'rotate' | 'plane'

/** Which pointer-down opened the session: the part itself, or a triad handle. */
export type GestureSource = 'body' | 'gizmo'

/** What the finished gesture was, for the caller to tell a click from a drag. */
export interface GestureOutcome {
  /** null when pointer-down opened no session at all. */
  source: GestureSource | null
  /** The session actually moved the part, so a re-solve is owed. */
  moved: boolean
}

const NO_GESTURE: GestureOutcome = { source: null, moved: false }

/**
 * Whether the pointer-up that ended this gesture may still toggle the B-rep
 * entity under the cursor into the measurement selection.
 *
 * Two things must never select. A gesture that began on a triad handle is
 * unambiguously a manipulation: the handle is drawn over the part, so the face
 * behind it is not what the user pointed at, however short the gesture was. And
 * a gesture that moved the part asked for a re-solve, which drops the selection
 * (the keys are positional) a few frames later -- selecting there only makes a
 * highlight that silently disappears.
 *
 * What is left is a body grab that never moved: a plain click on the part, which
 * selects exactly as it would with no session open.
 */
export function gestureAllowsSelect(outcome: GestureOutcome): boolean {
  return outcome.source !== 'gizmo' && !outcome.moved
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
  /** Selects the part; opens a drag session unless it is fixed. */
  onBodyPointerDown: (handle: string, grab: Vec3, viewNormal: Vec3) => boolean
  /**
   * `axis` is the world slide/swing axis, or for `plane` the plane's normal.
   * `axisName` names the same axis in part-local terms, for the drag state the
   * triad renders from. `reference` is the axis's `u` companion in world space:
   * a ring measures the grab bearing from it, and everything else ignores it.
   */
  onGizmoPointerDown: (
    handle: string,
    mode: GizmoMode,
    axisName: GizmoAxisName,
    axis: Vec3,
    reference: Vec3,
    origin: Vec3,
    ray: Ray,
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
  /** Commits the session (assemblyStore re-solves once) if one is open. */
  onPointerUp: () => GestureOutcome
  cancel: () => void
  isActive: () => boolean
}

export function createAssemblyPointerAdapter(store: AssemblyPointerStore): AssemblyPointerAdapter {
  let gesture: Gesture | null = null
  // What the open session is, kept beside the gesture so pointer-up can report
  // it once the gesture itself is gone. `moved` counts only moves that reached
  // the store: a pointermove landing back on the grab point drags by nothing and
  // must leave a click a click.
  let source: GestureSource | null = null
  let moved = false

  const open = (g: Gesture, from: GestureSource): true => {
    gesture = g
    source = from
    moved = false
    return true
  }

  const onBodyPointerDown = (handle: string, grab: Vec3, viewNormal: Vec3): boolean => {
    store.setSelectedPartHandle(handle)
    if (!store.beginPartManipulation(handle)) return false
    return open({ kind: 'plane', grab, normal: viewNormal }, 'body')
  }

  const onGizmoPointerDown = (
    handle: string,
    mode: GizmoMode,
    axisName: GizmoAxisName,
    rawAxis: Vec3,
    reference: Vec3,
    origin: Vec3,
    ray: Ray,
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
      return open({ kind: 'axis', axis, origin, startParam }, 'gizmo')
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
      return open({ kind: 'plane', grab: hit, normal: axis }, 'gizmo')
    }

    const startArm = sub(hit, origin)
    const datum = datumAngle(signedAngleAbout(axis, reference, startArm))
    // A swing of zero is a multiple of the step, so the dial starts on a tick.
    // Armed by construction: the pointer-down resolved on the ring's own grab
    // region, which is the boundary the gate is drawn at.
    store.setGizmoDrag({ kind: 'ring', axis: axisName, datum, swing: 0, snapped: true, snapArmed: true })
    return open({ kind: 'ring', axis, axisName, origin, startArm, swing: 0, datum }, 'gizmo')
  }

  const onPointerMove = (ray: Ray, gizmoWorldScale?: number): void => {
    if (!gesture) return

    if (gesture.kind === 'plane') {
      const hit = intersectRayPlane(ray, gesture.grab, gesture.normal)
      if (!hit) return
      const delta = sub(hit, gesture.grab)
      if (delta[0] !== 0 || delta[1] !== 0 || delta[2] !== 0) moved = true
      store.dragPartTranslate(delta)
      return
    }

    if (gesture.kind === 'axis') {
      const param = closestParamOnAxis(ray, gesture.origin, gesture.axis)
      if (param === null) return
      if (param !== gesture.startParam) moved = true
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
    if (snap.angle !== 0) moved = true
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

  const onPointerUp = (): GestureOutcome => {
    if (!gesture) {
      // Belt and braces. Nothing should be able to leave a drag published with
      // no gesture behind it, but a triad narrowed to a gesture that is not
      // running is unusable, so the release clears it whatever happened.
      store.setGizmoDrag(null)
      return NO_GESTURE
    }
    const outcome: GestureOutcome = { source, moved }
    gesture = null
    source = null
    store.endPartManipulation()
    return outcome
  }

  const cancel = (): void => {
    if (!gesture) return
    gesture = null
    source = null
    store.cancelPartManipulation()
  }

  return {
    onBodyPointerDown,
    onGizmoPointerDown,
    onPointerMove,
    onPointerUp,
    cancel,
    isActive: () => gesture !== null,
  }
}
