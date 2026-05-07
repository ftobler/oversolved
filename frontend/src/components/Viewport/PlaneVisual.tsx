/* eslint-disable react-refresh/only-export-components */

import { useRef } from 'react'
import { useThree, useFrame, type ThreeEvent } from '@react-three/fiber'
import { Line, Text } from '@react-three/drei'
import * as THREE from 'three'

const Y_OFFSET = 0.03
const LABEL_COLOR = '#888888'
const LABEL_OPACITY = 0.20

interface PlaneLabelProps {
  x: number
  y: number
  children: string
}

export function PlaneLabel({ x, y, children }: PlaneLabelProps) {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (groupRef.current) {
      const s = 12 / (('zoom' in camera) ? (camera as THREE.OrthographicCamera).zoom : 1)
      groupRef.current.scale.setScalar(s)
    }
  })
  return (
    <group ref={groupRef} position={[x + 1.0, y + Y_OFFSET, 0.001]}>
      <Text fontSize={3} color={LABEL_COLOR} fillOpacity={LABEL_OPACITY} anchorX="left" anchorY="top">
        {children}
      </Text>
    </group>
  )
}

export function planeBorderPoints(size: number): [number, number, number][] {
  const ph = size / 2
  return [
    [-ph, -ph, 0], [ph, -ph, 0], [ph, ph, 0], [-ph, ph, 0], [-ph, -ph, 0],
  ]
}

export type PlaneState = 'default' | 'hovered' | 'selected'

const STATE_STYLES: Record<PlaneState, { fillColor: string; fillOpacity: number; borderColor: string }> = {
  default: { fillColor: '#444444', fillOpacity: 0.05, borderColor: '#666666' },
  hovered: { fillColor: '#ffffff', fillOpacity: 0.08, borderColor: '#ffffff' },
  selected: { fillColor: '#ff9800', fillOpacity: 0.08, borderColor: '#ff9800' },
}

interface PlaneSurfaceProps {
  size: number
  state?: PlaneState
  /** @internal */ borderWidth?: never
  /** @internal */ borderOpacity?: never
  hideMesh?: boolean
  noRaycast?: boolean
  onPointerOver?: (e: ThreeEvent<PointerEvent>) => void
  onPointerOut?: () => void
  onClick?: (e: ThreeEvent<PointerEvent>) => void
}

const BORDER_WIDTH = 1
const BORDER_OPACITY = 0.5

export function PlaneSurface({ size, state = 'default', hideMesh, noRaycast, onPointerOver, onPointerOut, onClick }: PlaneSurfaceProps) {
  const points = planeBorderPoints(size)
  const { fillColor, fillOpacity, borderColor } = STATE_STYLES[state]

  return (
    <>
      {!hideMesh && (
        <mesh raycast={noRaycast ? () => null : undefined} onPointerOver={onPointerOver} onPointerOut={onPointerOut} onClick={onClick}>
          <planeGeometry args={[size, size]} />
          <meshBasicMaterial color={fillColor} transparent opacity={fillOpacity} side={THREE.DoubleSide} depthWrite={false} wireframe={false} />
        </mesh>
      )}
      <Line points={points} color={borderColor} lineWidth={BORDER_WIDTH} transparent opacity={BORDER_OPACITY} />
    </>
  )
}
