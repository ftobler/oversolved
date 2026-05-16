import { useRef } from 'react'
import { Line } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Line2 } from 'three-stdlib'
import { p2w, ARROW_SHAPE } from '@/components/sketch_helpers'

// Filled triangle arrowhead with constant pixel size regardless of zoom.
export function Arrowhead({ tip, from, color }: { tip: [number, number]; from: [number, number]; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0])
  useFrame(() => {
    if (meshRef.current) {
      const s = 12 * p2w(camera)
      meshRef.current.scale.set(s * 1.2, s * 0.9, 1)
    }
  })
  return (
    <mesh ref={meshRef} position={[tip[0], tip[1], 0]} rotation={[0, 0, angle]}>
      <shapeGeometry args={[ARROW_SHAPE]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} />
    </mesh>
  )
}

// Short tail line from a point in a direction, with constant pixel length regardless of zoom.
export function ArrowTail({ origin, dir, color }: { origin: [number, number]; dir: [number, number]; color: string }) {
  const lineRef = useRef<Line2>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (!lineRef.current) return
    const len = 25 * p2w(camera)
    const pts = lineRef.current.geometry?.attributes?.position
    if (pts) {
      pts.setXYZ(0, origin[0], origin[1], 0)
      pts.setXYZ(1, origin[0] + dir[0] * len, origin[1] + dir[1] * len, 0)
      pts.needsUpdate = true
    }
  })
  const len = 25 * p2w(camera)
  return (
    <Line ref={lineRef} points={[[origin[0], origin[1], 0], [origin[0] + dir[0] * len, origin[1] + dir[1] * len, 0]]} color={color} lineWidth={1} />
  )
}

// Line with dash/gap sizes in pixels, constant regardless of zoom.
export function DashedLine({ points, color, lineWidth, dashPx = 7.5, gapPx = 4.5, depthTest, renderOrder, onPointerOver, onPointerOut }: {
  points: [number, number, number][]
  color: string
  lineWidth: number
  dashPx?: number
  gapPx?: number
  depthTest?: boolean
  renderOrder?: number
  onPointerOver?: (e: { stopPropagation: () => void }) => void
  onPointerOut?: () => void
}) {
  const lineRef = useRef<Line2>(null)
  const { camera } = useThree()
  useFrame(() => {
    const mat = lineRef.current?.material
    if (!mat) return
    const scale = p2w(camera)
    mat.dashSize = dashPx * scale
    mat.gapSize = gapPx * scale
  })
  return <Line ref={lineRef} points={points} color={color} lineWidth={lineWidth} dashed dashSize={0.01} gapSize={0.005} depthTest={depthTest} renderOrder={renderOrder} onPointerOver={onPointerOver} onPointerOut={onPointerOut} />
}
