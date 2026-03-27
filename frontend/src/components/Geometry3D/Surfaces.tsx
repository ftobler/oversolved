import { useState, useMemo } from 'react'
import * as THREE from 'three'
import type { Topology, TopologySurface, TopologyEdge, TopologyArcEdge, Point } from '../../types/cad'
import { ARC_SEGMENTS } from './constants'

type SurfaceShape = { shape: THREE.Shape; pts: [number, number][] }

export function buildSurfaceShapes(topology: Topology): SurfaceShape[] {
  return topology.surfaces.flatMap((surface: TopologySurface) => {
    const pts: Point[] = []
    surface.boundary.forEach((edge: TopologyEdge, ei: number) => {
      if (ei === 0) pts.push(edge.start)
      if (edge.kind === 'line') {
        pts.push(edge.end)
      } else {
        const { center, radius, angle_start_deg, angle_end_deg, ccw } = edge as TopologyArcEdge
        const span = ccw
          ? ((angle_end_deg - angle_start_deg) + 360) % 360
          : -(((angle_start_deg - angle_end_deg) + 360) % 360)
        const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * ARC_SEGMENTS))
        for (let i = 1; i <= steps; i++) {
          const a = (angle_start_deg + (span * i) / steps) * (Math.PI / 180)
          pts.push([center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)])
        }
      }
    })
    if (pts.length < 3) return []
    const shape = new THREE.Shape()
    shape.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
    shape.closePath()
    return [{ shape, pts }]
  })
}

export function SurfaceMesh({ shape }: { shape: THREE.Shape }) {
  const [hovered, setHovered] = useState(false)
  return (
    <mesh
      position={[0, 0, -0.003]}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color="white" transparent opacity={hovered ? 0.15 : 0.10} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

interface TopologySurfacesProps {
  topology: Topology
}

export function TopologySurfaces({ topology }: TopologySurfacesProps) {
  const surfaces = useMemo(() => buildSurfaceShapes(topology), [topology])
  return (
    <>
      {surfaces.map((s, si) => <SurfaceMesh key={si} shape={s.shape} />)}
    </>
  )
}
