// One rotation ring of a gizmo, shared by the assembly triad and the section
// plane's tilt handles.
//
// Line art only: THREE.LineBasicMaterial's `linewidth` is ignored by most WebGL
// backends, so a real 2px-on-screen line needs drei's <Line>, which keeps its
// own LineMaterial/Line2 instead. `depthTest` stays off because a gizmo usually
// sits inside the solid it manipulates and must draw over it.
//
// The points come from `dialPoint`, the same angle-to-point math the angle
// dial's ticks are built from, so the drawn ring and the dial that grows out of
// it cannot disagree on where the circle sits.
import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import { dialPoint } from '@/utils/angleDialGeometry'
import { RING_RADIUS, type GizmoRingBasis } from '@/utils/gizmoPickGeometry'
import type { Vec3 } from '@/utils/transform3d'

const LINE_WIDTH = 2

// Fine enough that the ring reads as a circle rather than a polygon at gizmo
// scale (RING_RADIUS * GIZMO_PIXELS px radius on screen).
const RING_LINE_SEGMENTS = 64

export default function GizmoRing({ basis, color }: {
  // The ring's in-plane axes, right-handed about its rotation axis.
  basis: GizmoRingBasis
  color: string
}) {
  const points = useMemo<Vec3[]>(() => {
    const out: Vec3[] = []
    for (let i = 0; i <= RING_LINE_SEGMENTS; i++) {
      out.push(dialPoint(basis, (i / RING_LINE_SEGMENTS) * Math.PI * 2, RING_RADIUS))
    }
    return out
  }, [basis])

  return <Line points={points} color={color} lineWidth={LINE_WIDTH} depthTest={false} />
}
