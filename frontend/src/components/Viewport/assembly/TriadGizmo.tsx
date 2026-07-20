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

import { useMemo, useRef } from 'react'
import { Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import AngleDial from '@/components/Viewport/assembly/AngleDial'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import type { GizmoDragState } from '@/stores/assemblyStore'
import { dialPoint } from '@/utils/angleDialGeometry'
import {
  ARROW_HEAD_BASE, arrowHeadPositions, cylindricalBillboardAngle,
} from '@/utils/arrowHeadGeometry'
import {
  GIZMO_AXES, GIZMO_PIXELS, gizmoHandleKey,
  planeHandleCorners, planeHandleOutline, RING_RADIUS,
  type GizmoAxisDef,
} from '@/utils/gizmoPickGeometry'
import {
  TRIAD_COLOR, TRIAD_COLOR_HOVER, TRIAD_PLANE_OPACITY, TRIAD_PLANE_OPACITY_HOVER,
} from '@/utils/core/gizmoColors'
import type { Quat, Vec3 } from '@/utils/transform3d'

// Line art for everything but the arrowheads and the plane quads:
// THREE.LineBasicMaterial's `linewidth` is ignored by most WebGL backends, so a
// real 2px-on-screen line needs drei's <Line>, which keeps its own
// LineMaterial/Line2 instead (see Geometry3D/constants.ts). depthTest stays off
// on every piece: the triad sits at the part's origin, usually inside the
// solid, so it must draw over the body to stay grabbable.
const LINE_WIDTH = 2

// Per part axis: the euler angles that aim a +Y shaft-and-head arrow along it.
// No per-axis colour: the triad is uni-hue (see utils/core/gizmoColors), so
// that a handle is grabbable reads the same way on every handle, and hover is
// what carries meaning instead of hue.
const ARROW_ROTATIONS: [number, number, number][] = [
  [0, 0, -Math.PI / 2],
  [0, 0, 0],
  [Math.PI / 2, 0, 0],
]

// The shaft stops where the solid head begins rather than running under it:
// the billboarded head is coplanar with the shaft line by construction, so an
// overlapping stretch would fight it for pixels instead of being hidden by it.
const SHAFT_POINTS: Vec3[] = [[0, 0, 0], [0, ARROW_HEAD_BASE, 0]]

// Fine enough that the ring reads as a circle rather than a polygon at gizmo
// scale (RING_RADIUS * GIZMO_PIXELS px radius on screen).
const RING_LINE_SEGMENTS = 64

/**
 * A closed ring of points around `def`'s u/v plane, reusing the same
 * angle-to-point math the angle dial's ticks are built from (dialPoint), so
 * the drawn ring and the dial that grows out of it never disagree on where
 * the circle sits. Computed once per axis at module scope since GIZMO_AXES is
 * static, rather than recomputed on every TriadGizmo render.
 */
function ringLinePoints(def: GizmoAxisDef): Vec3[] {
  const points: Vec3[] = []
  for (let i = 0; i <= RING_LINE_SEGMENTS; i++) {
    points.push(dialPoint(def, (i / RING_LINE_SEGMENTS) * Math.PI * 2, RING_RADIUS))
  }
  return points
}

const RING_POINTS: Vec3[][] = GIZMO_AXES.map(ringLinePoints)

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

// Reused across frames and arrows: the billboard runs three times per frame,
// and a fresh Vector3 each time is pure churn for the collector.
const CAMERA_LOCAL = new THREE.Vector3()

/**
 * The solid arrowhead, spun about its own axis each frame so its face turns
 * toward the camera while its point stays on the shaft (see
 * utils/arrowHeadGeometry for why the spin is cylindrical and not a full
 * billboard). Drawn double-sided because the spin lands the back face toward
 * the viewer for half of the orbit.
 */
function ArrowHead({ color }: { color: string }) {
  const ref = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const positions = useMemo(() => arrowHeadPositions(), [])

  useFrame(() => {
    const mesh = ref.current
    if (!mesh?.parent) return
    // Asked of the PARENT, not of the mesh: the mesh's own world matrix carries
    // the rotation this callback is about to overwrite, so measuring through it
    // would make the head chase its own previous answer instead of settling.
    const local = mesh.parent.worldToLocal(CAMERA_LOCAL.copy(camera.position))
    mesh.rotation.y = cylindricalBillboardAngle([local.x, local.y, local.z])
  })

  return (
    <mesh ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      {/* depthWrite off alongside depthTest off, the pairing every other
          overlay here uses (FeatureHandles, Body3D): this is the triad's only
          opaque mesh, so without it the head would stamp its own far depth
          into the buffer while ignoring what is already there, and whatever
          drew after it would depth-test against a lie. */}
      <meshBasicMaterial
        color={color}
        side={THREE.DoubleSide}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  )
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
        color={hovered ? TRIAD_COLOR_HOVER : TRIAD_COLOR}
        transparent
        opacity={hovered ? TRIAD_PLANE_OPACITY_HOVER : TRIAD_PLANE_OPACITY}
        side={THREE.DoubleSide}
        depthTest={false}
      />
    </mesh>
  )
}

export default function TriadGizmo({ origin, orientation, hovered, drag }: TriadGizmoProps) {
  const ref = useScreenScale(GIZMO_PIXELS)
  const colorFor = (key: string) => (hovered === key ? TRIAD_COLOR_HOVER : TRIAD_COLOR)

  // Idle draws everything; a drag draws only the handle it grabbed. Each test
  // is "no drag, or this exact handle", so the null case is untouched.
  const shows = (kind: GizmoDragState['kind'], name: string) =>
    drag === null || (drag.kind === kind && drag.axis === name)

  return (
    <group position={origin} quaternion={orientation}>
      {/* No renderOrder on these groups: three.js promotes a Group's
          renderOrder to the groupOrder of its subtree and sorts on groupOrder
          before renderOrder, so it would out-sort the collision/ID debug pass
          (IdDebugOverlay, renderOrder 9999 at groupOrder 0) and hide it behind
          the gizmo. The per-axis <group> below already reset groupOrder to 0,
          so the 1000 that used to sit here reached nothing and its removal
          cannot move a pixel. Handles that must draw above their siblings say
          so on the drawn object itself, as the plane outline does. */}
      <group ref={ref}>
        {GIZMO_AXES.map((def, i) => {
          const arrowRotation = ARROW_ROTATIONS[i]
          return (
            <group key={def.name}>
              {shows('axis', def.name) && (
                <group rotation={arrowRotation}>
                  <Line
                    points={SHAFT_POINTS}
                    color={colorFor(gizmoHandleKey('translate', def.name))}
                    lineWidth={LINE_WIDTH}
                    depthTest={false}
                  />
                  <ArrowHead color={colorFor(gizmoHandleKey('translate', def.name))} />
                </group>
              )}

              {shows('ring', def.name) && (
                <Line
                  points={RING_POINTS[i]}
                  color={colorFor(gizmoHandleKey('rotate', def.name))}
                  lineWidth={LINE_WIDTH}
                  depthTest={false}
                />
              )}

              {shows('plane', def.name) && (
                <PlaneHandle def={def} hovered={hovered === gizmoHandleKey('plane', def.name)} />
              )}

              {/* Emphasis only, while the quad is actually held: a halo around
                  the one handle left on screen, with no grab region of its own. */}
              {drag?.kind === 'plane' && drag.axis === def.name && (
                <Line
                  points={planeHandleOutline(def)}
                  color={TRIAD_COLOR_HOVER}
                  lineWidth={1.5}
                  depthTest={false}
                  transparent
                  renderOrder={1001}
                />
              )}

              {/* The dial is built from def.u/def.v, the same basis the ring
                  line above is drawn in, so it sits in the gizmo frame
                  directly and is not nested inside a rotation group here. */}
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
