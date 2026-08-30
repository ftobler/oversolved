/* eslint-disable react-refresh/only-export-components -- module mixes the default component export with non-component helpers */

import { Suspense, useRef } from 'react'
import { useThree, useFrame, type ThreeEvent } from '@react-three/fiber'
import { Line, Text } from '@react-three/drei'
import * as THREE from 'three'
import { LABEL_CHARACTERS, LABEL_FONT } from '@/components/Viewport/labelFont'

const Y_OFFSET = 0.03
const LABEL_COLOR = '#888888'
const LABEL_OPACITY = 0.20
const LABEL_SIZE = 3

// Where the label's first baseline sits below the plane's top edge, in em.
//
// Anchored to the BASELINE on purpose. The obvious anchorY="top" hangs the text
// off the font's ascender, which troika reads from OS/2 sTypoAscender -- not a
// visual quantity, and wildly inconsistent between faces. Noto Sans (what
// troika used to resolve off the CDN) reports 1.069 em where the Roboto we now
// self-host reports 0.750 em. The anchor sits ON the plane's top edge, so that
// 0.32 em gap lifted the whole label up out of the quad the instant the font
// changed. The baseline has no such freedom, so the placement below is the same
// on any face.
//
// troika also offers "top-cap", which would express this more directly, but
// drei's anchorY type does not admit it and a cast is not worth it.
const LABEL_TOP_GAP_EM = 0.35  // clear space between the plane edge and the capitals
const LABEL_CAP_HEIGHT_EM = 0.71  // Roboto sCapHeight 1456/2048; sans faces cluster near this
const LABEL_BASELINE_DROP_EM = LABEL_TOP_GAP_EM + LABEL_CAP_HEIGHT_EM

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
      {/* R3F wraps ALL Canvas children in one Suspense boundary of its own, and
          a suspended boundary is not merely invisible: R3F's hideInstance sets
          object.visible = false on every host instance under it, so ANY leaf
          that suspends blanks the entire viewport (and takes OrbitControls down
          with it, see SceneController). drei's <Text> suspends on its font, so
          the label needs its own boundary to keep that blast radius local. The
          plane draws immediately; the label pops in a moment later. */}
      <Suspense fallback={null}>
        <Text
          font={LABEL_FONT}
          characters={LABEL_CHARACTERS}
          fontSize={LABEL_SIZE}
          color={LABEL_COLOR}
          fillOpacity={LABEL_OPACITY}
          anchorX="left"
          anchorY="top-baseline"
          // Local to the scaled group, so the drop stays a constant on-screen
          // distance as the user zooms, matching the label's own fixed size.
          position={[0, -LABEL_BASELINE_DROP_EM * LABEL_SIZE, 0]}
        >
          {children}
        </Text>
      </Suspense>
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
  selected: { fillColor: '#ff9800', fillOpacity: 0.05, borderColor: '#ff9800' },
}

interface PlaneSurfaceProps {
  size: number
  state?: PlaneState
  // @internal
  borderWidth?: never
  // @internal
  borderOpacity?: never
  hideMesh?: boolean
  onPointerOver?: (e: ThreeEvent<PointerEvent>) => void
  onPointerOut?: () => void
  onClick?: (e: ThreeEvent<PointerEvent>) => void
}

const BORDER_WIDTH = 1
const BORDER_OPACITY = 0.5

export function PlaneSurface({ size, state = 'default', hideMesh, onPointerOver, onPointerOut, onClick }: PlaneSurfaceProps) {
  const points = planeBorderPoints(size)
  const { fillColor, fillOpacity, borderColor } = STATE_STYLES[state]

  return (
    <>
      {!hideMesh && (
        // fitBounds: this fixed-world-size quad is the only stable mesh that
        // zoom-to-fit measures in its scene-traversal fallback (no solid body).
        // Screen-scaled helpers (markers, labels, dimension meshes, vertex dots)
        // size themselves as const/zoom, so measuring them would make the fit a
        // moving target that oscillates on repeated Reset Viewport presses.
        <mesh userData={{ fitBounds: true }} onPointerOver={onPointerOver} onPointerOut={onPointerOut} onClick={onClick}>
          <planeGeometry args={[size, size]} />
          <meshBasicMaterial color={fillColor} transparent opacity={fillOpacity} side={THREE.DoubleSide} depthWrite={false} wireframe={false} />
        </mesh>
      )}
      <Line points={points} color={borderColor} lineWidth={BORDER_WIDTH} transparent opacity={BORDER_OPACITY} />
    </>
  )
}
