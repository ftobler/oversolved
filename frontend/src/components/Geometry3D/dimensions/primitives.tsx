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
      <meshBasicMaterial color={color} side={THREE.DoubleSide} depthTest={false} />
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
    <Line ref={lineRef} points={[[origin[0], origin[1], 0], [origin[0] + dir[0] * len, origin[1] + dir[1] * len, 0]]} color={color} lineWidth={1} depthTest={false} />
  )
}

// Tail that follows the dimension arc (a circle centred at cx,cy with the given
// radius) instead of a straight tangent, so it does not kink away from a curved
// angular dimension. Length is constant in screen pixels; sign selects the
// angular travel direction (+1 CCW, -1 CW) from startAngleDeg.
const ARC_TAIL_STEPS = 8
export function ArcTail({ cx, cy, radius, startAngleDeg, sign, color, lengthPx = 25 }: {
  cx: number; cy: number; radius: number; startAngleDeg: number; sign: number; color: string; lengthPx?: number
}) {
  const lineRef = useRef<Line2>(null)
  const { camera } = useThree()
  const compute = (scale: number): [number, number, number][] => {
    const r = Math.max(Math.abs(radius), 1e-6)
    const dTheta = ((lengthPx * scale) / r) * Math.sign(sign || 1)
    const a0 = startAngleDeg * (Math.PI / 180)
    const pts: [number, number, number][] = []
    for (let i = 0; i <= ARC_TAIL_STEPS; i++) {
      const a = a0 + (dTheta * i) / ARC_TAIL_STEPS
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0])
    }
    return pts
  }
  useFrame(() => {
    const geo = lineRef.current?.geometry
    if (!geo) return
    const pts = compute(p2w(camera))
    geo.setPositions(pts.flat())
  })
  return <Line ref={lineRef} points={compute(p2w(camera))} color={color} lineWidth={1} depthTest={false} />
}

// Extension/witness line from the measured point to the dimension line. It
// starts a small constant screen-space gap away from the measured geometry and
// overshoots a small amount past the end (the arrow tip), both constant in
// pixels regardless of zoom.
const EXTENSION_OVERSHOOT_PX = 6
const EXTENSION_GAP_PX = 10
export function ExtensionLine({ start, end, color, overshootPx = EXTENSION_OVERSHOOT_PX, gapPx = EXTENSION_GAP_PX }: {
  start: [number, number]; end: [number, number]; color: string; overshootPx?: number; gapPx?: number
}) {
  const lineRef = useRef<Line2>(null)
  const { camera } = useThree()
  const compute = (scale: number): [number, number, number][] => {
    const dx = end[0] - start[0], dy = end[1] - start[1]
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const g = Math.min(gapPx * scale, len * 0.4)  // keep a visible witness line
    const o = overshootPx * scale
    return [[start[0] + ux * g, start[1] + uy * g, 0], [end[0] + ux * o, end[1] + uy * o, 0]]
  }
  useFrame(() => {
    const attr = lineRef.current?.geometry?.attributes?.position
    if (!attr) return
    const pts = compute(p2w(camera))
    attr.setXYZ(0, pts[0][0], pts[0][1], 0)
    attr.setXYZ(1, pts[1][0], pts[1][1], 0)
    attr.needsUpdate = true
  })
  return <Line ref={lineRef} points={compute(p2w(camera))} color={color} lineWidth={1} depthTest={false} />
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
