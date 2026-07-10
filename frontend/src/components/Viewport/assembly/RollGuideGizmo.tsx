// Stage 3's roll-guide arrow: while a `fixed` mate is selected, an arc from the
// mate's seed-relative zero roll out to its currently authored angle, drawn
// about ref_a's anchor axis at ref_a's anchor point.
//
// Screen-scaled like AnchorGizmos' triads, for the same reason: the guide has
// to read the same size at any zoom, not shrink to nothing on a huge part.

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { COLOR_SELECTED, RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import { buildRollGuide, type RollGuide } from '@/utils/rollGuide'
import type { Vec3 } from '@/utils/transform3d'

export const ROLL_GUIDE_RADIUS_PX = 24

export interface RollGuideSpec {
  point: Vec3
  axis: Vec3
  angleDeg: number
}

// Consecutive-pair segments, not a line strip: `<lineSegments>` is the JSX tag
// AnchorGizmos already uses, so the arc stays type-safe against the SVG `line`
// element react-three-fiber's own `<line>` intrinsic collides with.
function arcGeometry(guide: RollGuide): THREE.BufferGeometry {
  const segCount = Math.max(0, guide.arc.length - 1)
  const pts = new Float32Array(segCount * 6)
  for (let i = 0; i < segCount; i++) {
    pts.set(guide.arc[i], i * 6)
    pts.set(guide.arc[i + 1], i * 6 + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
  return g
}

export default function RollGuideGizmo({ spec }: { spec: RollGuideSpec | null }) {
  const ref = useScreenScale<THREE.Group>(ROLL_GUIDE_RADIUS_PX)

  // The arc is built about the local origin (radius baked in, point at [0,0,0])
  // so the enclosing group's screen-scale can size it uniformly; the group's
  // own position carries the anchor point, exactly as AnchorGizmos' triads do.
  const guide = useMemo(
    () => spec && buildRollGuide([0, 0, 0], spec.axis, spec.angleDeg, 1),
    [spec],
  )
  const geometry = useMemo(() => guide && arcGeometry(guide), [guide])

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!spec || !guide || !geometry) return null

  return (
    <group ref={ref} position={spec.point}>
      <lineSegments geometry={geometry} renderOrder={RENDER_ORDER_HIGHLIGHT}>
        <lineBasicMaterial color={COLOR_SELECTED} depthTest={false} transparent />
      </lineSegments>
    </group>
  )
}
