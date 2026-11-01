// The editing arrow: a screen-sized shaft and cone, optionally with a
// world-sized tail behind the grab point. Shared by the feature handles and the
// section plane's offset arrow so their proportions and materials cannot drift.
import type { ReactNode, RefObject } from 'react'
import type * as THREE from 'three'

// Proportions in screen pixels. The head is rescaled to p2w(camera) every frame
// by its owner, so it keeps a constant on-screen size at any zoom.
export const SHAFT_START = -10  // tailless (angular) arrows reach slightly behind the grab point
export const SHAFT_END = 26
export const SHAFT_RADIUS = 1.6
export const CONE_LEN = 16
export const CONE_RADIUS = 5.5
export const TIP = SHAFT_END + CONE_LEN

export interface ScreenArrowProps {
  color: string
  opacity?: number
  /** World length of the tail behind the grab point; 0 draws none. */
  tailLength?: number
  /** The tail is world-sized, so it cannot live in the uniformly scaled head group. */
  tailRef?: RefObject<THREE.Mesh | null>
  /** Where the screen-sized shaft begins; a tailed arrow starts at the grab point. */
  headStartPx?: number
  /** The head group, which the owner rescales to the current pixel size. */
  headRef?: RefObject<THREE.Group | null>
  /** World-per-pixel at rest, so the tail has a size before the first frame. */
  pixelsPerWorld?: number
  /** Content pinned to the arrow (a value label), inside the screen-sized head. */
  children?: ReactNode
}

export default function ScreenArrow({
  color,
  opacity = 1,
  tailLength = 0,
  tailRef,
  headStartPx = SHAFT_START,
  headRef,
  pixelsPerWorld = 1,
  children,
}: ScreenArrowProps) {
  return (
    <>
      {tailLength > 1e-9 && (
        <mesh
          ref={tailRef}
          position={[0, -tailLength / 2, 0]}
          scale={[SHAFT_RADIUS * pixelsPerWorld, tailLength, SHAFT_RADIUS * pixelsPerWorld]}
          renderOrder={1000}
        >
          <cylinderGeometry args={[1, 1, 1, 12]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} />
        </mesh>
      )}
      <group ref={headRef}>
        <mesh position={[0, (headStartPx + SHAFT_END) / 2, 0]} renderOrder={1000}>
          <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_END - headStartPx, 12]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} />
        </mesh>
        <mesh position={[0, SHAFT_END + CONE_LEN / 2, 0]} renderOrder={1000}>
          <coneGeometry args={[CONE_RADIUS, CONE_LEN, 16]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} depthTest={false} depthWrite={false} />
        </mesh>
        {children}
      </group>
    </>
  )
}
