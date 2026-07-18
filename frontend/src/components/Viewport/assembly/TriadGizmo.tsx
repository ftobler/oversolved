// The selected part's transform gizmo: one arrow per part axis (slide) and one
// ring per part axis (swing). The gizmo is rotated into the part's local frame,
// so a tilted part gets a tilted triad.
//
// Visuals only. Grabbing is not an R3F pointer handler here: the gizmo draws
// with `depthTest: false` while R3F's raycaster sorts by true distance, so a
// triad sitting inside its own part lost every pointer-down to the body. The
// grab regions are registered into the gizmoHandle ID layer by GizmoPickLayer
// instead, and dispatched by AssemblyViewport; the shared shape constants live
// in utils/gizmoPickGeometry.ts so what is drawn and what is grabbable cannot
// drift apart.
//
// Screen-scaled so the gizmo keeps its size as the user zooms, which also means
// a big and a small part get the same grab targets.

import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import {
  ARROW_LENGTH, GIZMO_PIXELS, HEAD_LENGTH, HEAD_RADIUS,
  RING_RADIUS, RING_TUBE, SHAFT_RADIUS,
} from '@/utils/gizmoPickGeometry'
import type { Quat, Vec3 } from '@/utils/transform3d'

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
}

export default function TriadGizmo({ origin, orientation }: TriadGizmoProps) {
  const ref = useScreenScale(GIZMO_PIXELS)

  return (
    <group position={origin} quaternion={orientation}>
      <group ref={ref} renderOrder={1000}>
        {AXES.map(({ color, arrowRotation, ringRotation }) => (
          <group key={color}>
            <group rotation={arrowRotation}>
              <mesh position={[0, ARROW_LENGTH / 2, 0]}>
                <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, ARROW_LENGTH, 8]} />
                <meshBasicMaterial color={color} depthTest={false} />
              </mesh>
              <mesh position={[0, ARROW_LENGTH, 0]}>
                <coneGeometry args={[HEAD_RADIUS, HEAD_LENGTH, 12]} />
                <meshBasicMaterial color={color} depthTest={false} />
              </mesh>
            </group>

            <group rotation={ringRotation}>
              <mesh>
                <torusGeometry args={[RING_RADIUS, RING_TUBE, 6, 48]} />
                <meshBasicMaterial color={color} depthTest={false} />
              </mesh>
            </group>
          </group>
        ))}
      </group>
    </group>
  )
}
