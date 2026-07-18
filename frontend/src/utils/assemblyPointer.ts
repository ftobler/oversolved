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
  onPointerUp: () => void
  cancel: () => void
  isActive: () => boolean
}

export function createAssemblyPointerAdapter(store: AssemblyPointerStore): AssemblyPointerAdapter {
  let gesture: Gesture | null = null

  const onBodyPointerDown = (handle: string, grab: Vec3, viewNormal: Vec3): boolean => {
    store.setSelectedPartHandle(handle)
    if (!store.beginPartManipulation(handle)) return false
    gesture = { kind: 'plane', grab, normal: viewNormal }
    return true
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
      gesture = { kind: 'axis', axis, origin, startParam }
      return true
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
      gesture = { kind: 'plane', grab: hit, normal: axis }
      return true
    }

    gesture = { kind: 'ring', axis, origin, startArm: sub(hit, origin), swing: 0 }
    return true
  }

  const onPointerMove = (ray: Ray): void => {
    if (!gesture) return

    if (gesture.kind === 'plane') {
      const hit = intersectRayPlane(ray, gesture.grab, gesture.normal)
      if (!hit) return
      store.dragPartTranslate(sub(hit, gesture.grab))
      return
    }

    if (gesture.kind === 'axis') {
      const param = closestParamOnAxis(ray, gesture.origin, gesture.axis)
      if (param === null) return
      store.dragPartTranslate(scale(gesture.axis, param - gesture.startParam))
      return
    }

    const hit = intersectRayPlane(ray, gesture.origin, gesture.axis)
    if (!hit) return
    const measured = signedAngleAbout(gesture.axis, gesture.startArm, sub(hit, gesture.origin))
    gesture.swing = unwrapAngle(measured, gesture.swing)
    store.rotatePartGizmo(gesture.axis, gesture.swing, gesture.origin)
  }

  const onPointerUp = (): void => {
    if (!gesture) return
    gesture = null
    store.endPartManipulation()
  }

  const cancel = (): void => {
    if (!gesture) return
    gesture = null
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
