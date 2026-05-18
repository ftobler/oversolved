import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

export const ENV_INTENSITY = 0.4  // overall 'Image Based Lighting' (IBL) brightness
export const ENV_MAP_INTENSITY = 0.0  // per-material reflection strength

const _euler = new THREE.Euler()

export default function EnvLight() {
  const { camera, scene } = useThree()

  useFrame(() => {
    _euler.setFromQuaternion(camera.quaternion, 'YXZ')
    // Swap X/Y to correct environment-map axis convention vs camera convention.
    scene.environmentRotation.set(_euler.x, _euler.y, _euler.z)
  })

  return null
}
