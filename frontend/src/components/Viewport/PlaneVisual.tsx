/* eslint-disable react-refresh/only-export-components */

import { Suspense, useRef } from 'react'
import { useThree, useFrame, type ThreeEvent } from '@react-three/fiber'
import { Line, Text } from '@react-three/drei'
import { preload } from 'suspend-react'
import { preloadFont } from 'troika-three-text'
import * as THREE from 'three'

const Y_OFFSET = 0.03
const LABEL_COLOR = '#888888'
const LABEL_OPACITY = 0.20

// The font arguments every plane label renders with. drei's <Text> gates its
// first paint on `suspend(..., ['troika-text', font, characters])`, and with the
// font unset troika resolves it by fetching a codepoint index and a .woff off a
// CDN. Left cold, that network round trip runs on whichever gesture first mounts
// a label (unhiding a plane), and R3F gives the whole Canvas a single Suspense
// boundary, so the entire viewport blanks until it lands.
//
// These constants feed BOTH the <Text> props and the warm-up key below, so the
// preload cannot drift onto a different cache entry than the one <Text> looks
// up. suspend-react matches keys by identity per slot, so a mismatch here would
// silently fill a neighbouring entry and fix nothing.
const LABEL_FONT: string | undefined = undefined
const LABEL_CHARACTERS: string | undefined = undefined
const LABEL_FONT_KEY = ['troika-text', LABEL_FONT, LABEL_CHARACTERS]

/**
 * Fills drei's font cache ahead of the first label mount, so the fetch is paid
 * at app startup instead of on the user's gesture. Idempotent: suspend-react
 * returns the existing entry rather than refetching.
 *
 * It must go through suspend-react's `preload`, NOT `preloadFont` on its own.
 * Calling preloadFont directly warms troika's own internal font cache, which
 * looks like it should be enough and is not: drei gates on its suspend-react
 * entry, so with that entry still empty <Text> throws a promise on first mount
 * anyway and the viewport still flashes -- just for a shorter time, which makes
 * the bug look fixed while leaving it in. `preload` registers the entry under
 * the same key without throwing, which is the part that actually matters.
 */
export function preloadPlaneLabelFont(): void {
  preload(
    () => new Promise<void>(resolve => {
      preloadFont({ font: LABEL_FONT, characters: LABEL_CHARACTERS }, () => resolve())
    }),
    LABEL_FONT_KEY,
  )
}

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
          fontSize={3}
          color={LABEL_COLOR}
          fillOpacity={LABEL_OPACITY}
          anchorX="left"
          anchorY="top"
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
  /** @internal */ borderWidth?: never
  /** @internal */ borderOpacity?: never
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
