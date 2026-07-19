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
// A grounded (`fixed`) part still selects on click but never opens a session:
// beginPartManipulation refuses it, and we leave no gesture behind, so the
// following move/up are inert. Grounding is the assembly's static frame, and it
// is enforced again in setInstanceTransform — the UI is not the only guard.

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
import type { Vec3 } from '@/utils/transform3d'

/** The subset of assemblyStore the adapter drives. */
export interface AssemblyPointerStore {
  beginPartManipulation: (handle: string) => boolean
  dragPartTranslate: (delta: Vec3) => void
  rotatePartGizmo: (axis: Vec3, angle: number, pivot?: Vec3) => void
  endPartManipulation: () => void
  cancelPartManipulation: () => void
  setSelectedPartHandle: (handle: string | null) => void
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

type Gesture =
  | { kind: 'plane'; grab: Vec3; normal: Vec3 }
  | { kind: 'axis'; axis: Vec3; origin: Vec3; startParam: number }
  // `swing` is the running total since pointer-down, the one piece of gesture
  // state carried frame to frame: the measured angle alone tops out at a half
  // turn, so it is unwrapped against this to let a drag keep going round.
  | { kind: 'ring'; axis: Vec3; origin: Vec3; startArm: Vec3; swing: number }

export interface AssemblyPointerAdapter {
  /** Selects the part; opens a drag session unless it is grounded. */
  onBodyPointerDown: (handle: string, grab: Vec3, viewNormal: Vec3) => boolean
  /** `axis` is the world slide/swing axis, or for `plane` the plane's normal. */
  onGizmoPointerDown: (handle: string, mode: GizmoMode, axis: Vec3, origin: Vec3, ray: Ray) => boolean
  onPointerMove: (ray: Ray) => void
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
    rawAxis: Vec3,
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
      return open({ kind: 'plane', grab: hit, normal: axis }, 'gizmo')
    }

    return open({ kind: 'ring', axis, origin, startArm: sub(hit, origin), swing: 0 }, 'gizmo')
  }

  const onPointerMove = (ray: Ray): void => {
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
    const measured = signedAngleAbout(gesture.axis, gesture.startArm, sub(hit, gesture.origin))
    gesture.swing = unwrapAngle(measured, gesture.swing)
    if (gesture.swing !== 0) moved = true
    store.rotatePartGizmo(gesture.axis, gesture.swing, gesture.origin)
  }

  const onPointerUp = (): GestureOutcome => {
    if (!gesture) return NO_GESTURE
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
