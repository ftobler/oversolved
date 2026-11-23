import * as THREE from 'three'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'

/** 10-gon dot with constant pixel radius regardless of zoom.
 *  If billboard=true the dot always faces the camera.
 *  renderOrder and depthTest control z-ordering (use for always-on-top elements).
 *
 *  `transparent` is separate from depth: a sketch vertex dot rides the sorted
 *  transparent pass even while it is depth-tested, so the area fill beneath it
 *  cannot paint over it. It is a prop rather than `!depthTest` because the two
 *  questions stopped having the same answer. */
export function Dot({ x, y, px, color, billboard = false, renderOrder = 0, depthTest = true, transparent }: {
  x: number; y: number; px: number; color: string; billboard?: boolean; renderOrder?: number; depthTest?: boolean; transparent?: boolean
}) {
  const meshRef = useScreenScale<THREE.Mesh>(px, { billboard })
  return (
    <mesh ref={meshRef} position={[x, y, 0]} renderOrder={renderOrder}>
      <circleGeometry args={[1, 10]} />
      <meshBasicMaterial color={color} side={THREE.DoubleSide} depthTest={depthTest} transparent={transparent ?? !depthTest} />
    </mesh>
  )
}
