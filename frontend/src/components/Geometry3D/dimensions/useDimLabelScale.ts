import * as THREE from 'three'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'

/**
 * Ref for a dimension label mesh kept at a constant ~30px on-screen size,
 * rescaling every frame against the current camera. Shared by all dimension
 * label components (Linear / Radial / Diameter / Angle).
 */
export function useDimLabelScale() {
  return useScreenScale<THREE.Mesh>(30)
}
