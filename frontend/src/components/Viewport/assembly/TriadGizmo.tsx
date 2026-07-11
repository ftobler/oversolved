// The selected part's transform gizmo: one arrow per part axis (slide) and one
// ring per part axis (swing). The gizmo is rotated into the part's local frame,
// so a tilted part gets a tilted triad; the axis each handle reports is that
// local axis expressed in world space, which is the frame the ray math in
// utils/gizmoMath.ts and the gesture state in utils/assemblyPointer.ts already
// operate in, so the interaction stays testable without a canvas.
//
// Screen-scaled so the gizmo keeps its size as the user zooms, which also means
// a big and a small part get the same grab targets.

import type { ThreeEvent } from '@react-three/fiber'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import type { GizmoMode } from '@/utils/assemblyPointer'
import { rotateVector, type Quat, type Vec3 } from '@/utils/transform3d'

const GIZMO_PIXELS = 90
const ARROW_LENGTH = 1
const SHAFT_RADIUS = 0.02
const HEAD_LENGTH = 0.18
const HEAD_RADIUS = 0.06
const RING_RADIUS = 0.75
const RING_TUBE = 0.02
// The visible tube is thin; a fatter invisible torus carries the raycast so the
// ring is grabbable without pixel-hunting.
const RING_PICK_TUBE = 0.06

const AXES: { axis: Vec3; color: string; arrowRotation: [number, number, number]; ringRotation: [number, number, number] }[] = [
  // A cylinder/cone points +Y and a torus lies in XY (normal +Z) by default.
  { axis: [1, 0, 0], color: '#e5533d', arrowRotation: [0, 0, -Math.PI / 2], ringRotation: [0, Math.PI / 2, 0] },
  { axis: [0, 1, 0], color: '#7cbb45', arrowRotation: [0, 0, 0],           ringRotation: [-Math.PI / 2, 0, 0] },
  { axis: [0, 0, 1], color: '#3d7ee5', arrowRotation: [Math.PI / 2, 0, 0], ringRotation: [0, 0, 0] },
]

interface TriadGizmoProps {
  origin: Vec3
  /** The part's world orientation; the triad is drawn in this frame. */
  orientation: Quat
  onGrab: (mode: GizmoMode, axis: Vec3, event: ThreeEvent<PointerEvent>) => void
}

export default function TriadGizmo({ origin, orientation, onGrab }: TriadGizmoProps) {
  const ref = useScreenScale(GIZMO_PIXELS)

  // The handles carry the local axis; the ray math wants it in world space, so
  // rotate it by the part orientation the group is also drawn in.
  const grab = (mode: GizmoMode, axis: Vec3) => (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    onGrab(mode, rotateVector(orientation, axis), e)
  }

  return (
    <group position={origin} quaternion={orientation}>
      <group ref={ref} renderOrder={1000}>
        {AXES.map(({ axis, color, arrowRotation, ringRotation }) => (
          <group key={color}>
            <group rotation={arrowRotation} onPointerDown={grab('translate', axis)}>
              <mesh position={[0, ARROW_LENGTH / 2, 0]}>
                <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, ARROW_LENGTH, 8]} />
                <meshBasicMaterial color={color} depthTest={false} />
              </mesh>
              <mesh position={[0, ARROW_LENGTH, 0]}>
                <coneGeometry args={[HEAD_RADIUS, HEAD_LENGTH, 12]} />
                <meshBasicMaterial color={color} depthTest={false} />
              </mesh>
            </group>

            <group rotation={ringRotation} onPointerDown={grab('rotate', axis)}>
              <mesh>
                <torusGeometry args={[RING_RADIUS, RING_TUBE, 6, 48]} />
                <meshBasicMaterial color={color} depthTest={false} />
              </mesh>
              <mesh>
                <torusGeometry args={[RING_RADIUS, RING_PICK_TUBE, 4, 24]} />
                <meshBasicMaterial visible={false} depthTest={false} />
              </mesh>
            </group>
          </group>
        ))}
      </group>
    </group>
  )
}
