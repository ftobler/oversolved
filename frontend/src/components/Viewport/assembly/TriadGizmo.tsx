// The selected part's transform gizmo: one arrow per part axis (slide), one
// ring per part axis (swing) and one quad per part plane (slide within it). The
// gizmo is rotated into the part's local frame, so a tilted part gets a tilted
// triad.
//
// Visuals only. Grabbing is not an R3F pointer handler here: the gizmo draws
// with `depthTest: false` while R3F's raycaster sorts by true distance, so a
// triad sitting inside its own part lost every pointer-down to the body. The
// grab regions are registered into the gizmoHandle ID layer by GizmoPickLayer
// instead, and dispatched by AssemblyViewport; the shared shape constants (and
// the plane quad's exact corners) live in utils/gizmoPickGeometry.ts so what is
// drawn and what is grabbable cannot drift apart.
//
// Screen-scaled so the gizmo keeps its size as the user zooms, which also means
// a big and a small part get the same grab targets.

import { useMemo } from 'react'
import * as THREE from 'three'
import AngleDial from '@/components/Viewport/assembly/AngleDial'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import type { GizmoDragState } from '@/stores/assemblyStore'
import {
  ARROW_LENGTH, GIZMO_AXES, GIZMO_PIXELS, gizmoHandleKey, HEAD_LENGTH, HEAD_RADIUS,
  planeHandleCorners, RING_RADIUS, RING_TUBE, SHAFT_RADIUS, type GizmoAxisDef,
} from '@/utils/gizmoPickGeometry'
import { COLOR_HOVER, COLOR_PREVIEW_EDGE } from '@/utils/core/partColors'
import type { Quat, Vec3 } from '@/utils/transform3d'

const PLANE_OPACITY = 0.3
const PLANE_OPACITY_HOVER = 0.62

// Per part axis: the euler angles that aim a +Y cylinder/cone and a +Z-normal
// torus along it. No per-axis colour: the triad is uni-violet, so that a handle
// is grabbable reads the same way here as it does on the extrusion arrows and
// the preview overlay, and hover is what carries meaning instead of hue.
const AXES: { arrowRotation: [number, number, number]; ringRotation: [number, number, number] }[] = [
  { arrowRotation: [0, 0, -Math.PI / 2], ringRotation: [0, Math.PI / 2, 0] },
  { arrowRotation: [0, 0, 0],            ringRotation: [-Math.PI / 2, 0, 0] },
  { arrowRotation: [Math.PI / 2, 0, 0],  ringRotation: [0, 0, 0] },
]

interface TriadGizmoProps {
  origin: Vec3
  /** The part's world orientation; the triad is drawn in this frame. */
  orientation: Quat
  /** Entity key of the handle under the cursor, straight from the ID buffer. */
  hovered: string | null
  /**
   * The gesture in progress, or null when idle. Non-null narrows the triad down
   * to the one handle being dragged: the other eight would only be clutter over
   * a motion the user has already committed to, and a ring drag needs the room
   * for its dial.
   */
  drag: GizmoDragState | null
}

/**
 * A plane handle's quad, built from the very corner list the ID layer
 * registers. The quad is drawn unrotated in the gizmo's own frame because the
 * corners are already expressed there.
 */
function PlaneHandle({ def, hovered }: { def: GizmoAxisDef; hovered: boolean }) {
  const positions = useMemo(() => {
    const [a, b, c, d] = planeHandleCorners(def)
    return new Float32Array([...a, ...b, ...c, ...a, ...c, ...d])
  }, [def])

  return (
    <mesh>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshBasicMaterial
        color={hovered ? COLOR_HOVER : COLOR_PREVIEW_EDGE}
        transparent
        opacity={hovered ? PLANE_OPACITY_HOVER : PLANE_OPACITY}
        side={THREE.DoubleSide}
        depthTest={false}
      />
    </mesh>
  )
}

export default function TriadGizmo({ origin, orientation, hovered, drag }: TriadGizmoProps) {
  const ref = useScreenScale(GIZMO_PIXELS)
  const colorFor = (key: string) => (hovered === key ? COLOR_HOVER : COLOR_PREVIEW_EDGE)

  // Idle draws everything; a drag draws only the handle it grabbed. Each test
  // is "no drag, or this exact handle", so the null case is untouched.
  const shows = (kind: GizmoDragState['kind'], name: string) =>
    drag === null || (drag.kind === kind && drag.axis === name)

  return (
    <group position={origin} quaternion={orientation}>
      <group ref={ref} renderOrder={1000}>
        {GIZMO_AXES.map((def, i) => {
          const { arrowRotation, ringRotation } = AXES[i]
          return (
            <group key={def.name}>
              {shows('axis', def.name) && (
                <group rotation={arrowRotation}>
                  <mesh position={[0, ARROW_LENGTH / 2, 0]}>
                    <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, ARROW_LENGTH, 8]} />
                    <meshBasicMaterial color={colorFor(gizmoHandleKey('translate', def.name))} depthTest={false} />
                  </mesh>
                  <mesh position={[0, ARROW_LENGTH, 0]}>
                    <coneGeometry args={[HEAD_RADIUS, HEAD_LENGTH, 12]} />
                    <meshBasicMaterial color={colorFor(gizmoHandleKey('translate', def.name))} depthTest={false} />
                  </mesh>
                </group>
              )}

              {shows('ring', def.name) && (
                <group rotation={ringRotation}>
                  <mesh>
                    <torusGeometry args={[RING_RADIUS, RING_TUBE, 6, 48]} />
                    <meshBasicMaterial color={colorFor(gizmoHandleKey('rotate', def.name))} depthTest={false} />
                  </mesh>
                </group>
              )}

              {shows('plane', def.name) && (
                <PlaneHandle def={def} hovered={hovered === gizmoHandleKey('plane', def.name)} />
              )}

              {/* The dial is built from def.u/def.v rather than ringRotation, so
                  it sits in the gizmo frame directly and is not nested here. */}
              {drag?.kind === 'ring' && drag.axis === def.name && (
                <AngleDial
                  def={def}
                  datum={drag.datum}
                  swing={drag.swing}
                  snapped={drag.snapped}
                  snapArmed={drag.snapArmed}
                />
              )}
            </group>
          )
        })}
      </group>
    </group>
  )
}
