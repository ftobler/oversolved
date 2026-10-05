// Hover-gated anchor gizmos (Stage 7.5). A part carries ~54 anchors, so drawing
// them all would bury the geometry; instead the hovered entity's anchors (the
// exact set a mate pick would cycle) appear as mini gizmos at their points.
//
// Each gizmo is drawn as three RGB rings around the anchor's display frame plus
// a dot at the anchor point, which reads as a small round orb rather than a bare
// triad. The red ring encircles the anchor's own axis (a face normal, an edge
// direction, a cylinder axis); green and blue encircle the two derived display
// axes (utils/anchorGizmos.ts), which carry no solve meaning. The center dot
// turns to the selected colour on the reference a mate chip would commit.

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { COLOR_HOVER, COLOR_SELECTED, RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import type { AnchorGizmo } from '@/utils/anchorGizmos'
import type { Vec3 } from '@/utils/transform3d'

/** Ring radius on screen. Constant in pixels, so a gizmo reads the same at any zoom. */
const ANCHOR_GIZMO_PX = 14

/** Ring colours, keyed to the display frame's axes: axis[0] red, [1] green, [2] blue. */
const RING_COLORS = [0xff4d4d, 0x4dff4d, 0x4d8dff] as const

const RING_SEGMENTS = 48

// A closed ring in the plane spanned by two orthonormal axes, emitted as
// consecutive-pair segments for `<lineSegments>` (the tag AnchorGizmos and the
// roll guide share to dodge react-three-fiber's `<line>` intrinsic collision).
function ringGeometry(u: Vec3, v: Vec3): THREE.BufferGeometry {
  const pts = new Float32Array(RING_SEGMENTS * 6)
  for (let i = 0; i < RING_SEGMENTS; i++) {
    for (const [slot, step] of [[0, i], [3, i + 1]] as const) {
      const a = (step / RING_SEGMENTS) * Math.PI * 2
      const c = Math.cos(a); const s = Math.sin(a)
      pts.set([u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s], i * 6 + slot)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
  return g
}

function AnchorTriad({ gizmo }: { gizmo: AnchorGizmo }) {
  // The rings are unit vectors in world directions and the group carries no
  // rotation, so screen-scaling the group is the whole of the sizing.
  const ref = useScreenScale<THREE.Group>(ANCHOR_GIZMO_PX)

  // Each ring encircles one axis, so it lives in the plane of the other two.
  const rings = useMemo(() => {
    const [x, y, z] = gizmo.axes
    return [ringGeometry(y, z), ringGeometry(z, x), ringGeometry(x, y)]
  }, [gizmo.axes])

  useEffect(() => () => rings.forEach(g => g.dispose()), [rings])

  return (
    <group ref={ref} position={gizmo.point}>
      {rings.map((geometry, i) => (
        <lineSegments key={i} geometry={geometry} renderOrder={RENDER_ORDER_HIGHLIGHT}>
          <lineBasicMaterial color={RING_COLORS[i]} depthTest={false} transparent />
        </lineSegments>
      ))}
      <mesh renderOrder={RENDER_ORDER_HIGHLIGHT}>
        <sphereGeometry args={[0.16, 12, 12]} />
        <meshBasicMaterial color={gizmo.aimed ? COLOR_SELECTED : COLOR_HOVER} depthTest={false} transparent />
      </mesh>
    </group>
  )
}

export default function AnchorGizmos({ gizmos }: { gizmos: AnchorGizmo[] }) {
  return <>{gizmos.map(g => <AnchorTriad key={g.key} gizmo={g} />)}</>
}
