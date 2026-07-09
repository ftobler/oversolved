// Hover-gated anchor gizmos (Stage 7.5). A part carries ~54 anchors, so drawing
// them all would bury the geometry; instead the hovered entity's anchors (the
// exact set a mate pick would cycle) appear as mini triads at their points.
//
// The triad's primary arm is the anchor's axis (a face normal, an edge
// direction, a cylinder axis). The other two are derived for display only
// (utils/anchorGizmos.ts) and never enter the solve, so they are drawn dimmer:
// they mark the anchor's plane, not a roll reference.

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { COLOR_HOVER, COLOR_INACTIVE, COLOR_SELECTED, RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import type { AnchorGizmo } from '@/utils/anchorGizmos'

/** Arm length on screen. Constant in pixels, so a triad reads the same at any zoom. */
export const ANCHOR_GIZMO_PX = 16

function segmentsFrom(origin: [number, number, number], dirs: [number, number, number][]): THREE.BufferGeometry {
  const pts = new Float32Array(dirs.length * 6)
  dirs.forEach((d, i) => {
    pts.set(origin, i * 6)
    pts.set(d, i * 6 + 3)
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
  return g
}

function AnchorTriad({ gizmo }: { gizmo: AnchorGizmo }) {
  // The arms are unit vectors in world directions and the group carries no
  // rotation, so screen-scaling the group is the whole of the sizing.
  const ref = useScreenScale<THREE.Group>(ANCHOR_GIZMO_PX)

  const [primary, secondary] = gizmo.axes
  const tertiary = gizmo.axes[2]

  const primaryGeom = useMemo(() => segmentsFrom([0, 0, 0], [primary]), [primary])
  const secondaryGeom = useMemo(() => segmentsFrom([0, 0, 0], [secondary, tertiary]), [secondary, tertiary])

  useEffect(() => () => { primaryGeom.dispose(); secondaryGeom.dispose() }, [primaryGeom, secondaryGeom])

  return (
    <group ref={ref} position={gizmo.point}>
      <lineSegments geometry={primaryGeom} renderOrder={RENDER_ORDER_HIGHLIGHT}>
        <lineBasicMaterial color={gizmo.aimed ? COLOR_SELECTED : COLOR_HOVER} depthTest={false} transparent />
      </lineSegments>
      <lineSegments geometry={secondaryGeom} renderOrder={RENDER_ORDER_HIGHLIGHT}>
        <lineBasicMaterial color={COLOR_INACTIVE} depthTest={false} transparent />
      </lineSegments>
    </group>
  )
}

export default function AnchorGizmos({ gizmos }: { gizmos: AnchorGizmo[] }) {
  return <>{gizmos.map(g => <AnchorTriad key={g.key} gizmo={g} />)}</>
}
