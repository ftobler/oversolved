import { useState, useEffect } from 'react'
import { useIdPipeline } from '@/picking'
import { buildOverlayMaterial, updateOverlayTexture } from './IdDebugOverlayMaterial'

/**
 * Full-screen quad that samples the ID render target and recolours each
 * non-empty pixel into a stable, visually distinct hue.
 *
 * Mounted by Viewport when `useSketchEditorStore.showDebugHit` is true.
 * Returns null when no ID pipeline is available (e.g. tests, or before
 * `IdPickingDriver` has finished its first effect).
 *
 * Color recipe matches `bitReverse24.ts` / `id-buffer-debug-overlay.md`:
 *   1. decode the RGB into a 24-bit integer ID
 *   2. reverse the 24 bits (sequential IDs become maximally separated)
 *   3. take the low 16 bits as a hue, with saturation 0.85 and value 0.95
 *
 * The legacy showDebugHit per-face-color path in `Body3D.tsx` was removed
 * when this overlay shipped (#265); this is the new behaviour of the flag.
 */
export default function IdDebugOverlay() {
  const pipeline = useIdPipeline()
  const [material] = useState(buildOverlayMaterial)

  useEffect(() => {
    return () => { material.dispose() }
  }, [material])

  useEffect(() => {
    updateOverlayTexture(material, pipeline?.target.target.texture ?? null)
  }, [material, pipeline])

  if (!pipeline) return null

  // The quad lives in NDC: vertices already span [-1, 1] so the vertex
  // shader can pass them straight through without a camera transform.
  return (
    <mesh frustumCulled={false} renderOrder={9999} material={material} raycast={() => undefined}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[new Float32Array([
            -1, -1, 0,
             3, -1, 0,
            -1,  3, 0,
          ]), 3]}
        />
      </bufferGeometry>
    </mesh>
  )
}
