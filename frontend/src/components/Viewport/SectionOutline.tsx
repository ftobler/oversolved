import type * as THREE from 'three'

export interface SectionOutlineProps {
  geometry: THREE.BufferGeometry
  // The fitted rectangle's centre; the arrow keeps the plane anchor, which the
  // rectangle always contains.
  center: [number, number, number]
  // Maps local X/Y/Z onto the plane's tilted `u`/`v`/normal.
  quaternion: THREE.Quaternion
  color: string
}

/**
 * The faint rectangle marking where the section plane sits. Presentational on
 * purpose: the handle decides the fitted size, and this only draws it, so the
 * geometry and pose stay inspectable at the component seam.
 */
export default function SectionOutline({ geometry, center, quaternion, color }: SectionOutlineProps) {
  return (
    <group position={center} quaternion={quaternion}>
      <lineLoop geometry={geometry} renderOrder={1000} raycast={() => undefined}>
        <lineBasicMaterial color={color} transparent opacity={0.35} depthTest={false} depthWrite={false} />
      </lineLoop>
    </group>
  )
}
