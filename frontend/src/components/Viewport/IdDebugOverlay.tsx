import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { useIdPipeline } from '@/picking'
import { buildOverlayMaterial, updateOverlayTexture } from './IdDebugOverlayMaterial'

/**
 * Full-screen quad that samples the ID render target and recolours each
 * non-empty pixel into a stable, visually distinct hue.
 *
 * Mounted by a viewport while `viewOptionsStore.collisionDebug` is true.
 * Returns null when no ID pipeline is available (e.g. tests, or before
 * `IdPickingDriver` has finished its first effect).
 *
 * Color recipe:
 *   1. decode the RGB into a 24-bit integer ID
 *   2. map id to hue via golden ratio (fract(id * phi)) for optimal
 *      visual separation between sequential IDs
 *   3. empty pixels (alpha < 0.5) render as black
 */
export default function IdDebugOverlay() {
  const pipeline = useIdPipeline()
  // The section swaps the ID target (stencil on/off), which replaces and
  // disposes its texture. Subscribe to the pipeline's target revision rather
  // than to a store flag: the bind effect must rerun whenever the texture
  // identity changes, even if the section's resolved state does not.
  const subscribe = useCallback(
    (onChange: () => void) => pipeline?.subscribeTargetRevision(onChange) ?? (() => {}),
    [pipeline],
  )
  const targetRevision = useSyncExternalStore(
    subscribe,
    () => pipeline?.getTargetRevision() ?? 0,
  )
  const [material] = useState(buildOverlayMaterial)

  useEffect(() => {
    return () => { material.dispose() }
  }, [material])

  useEffect(() => {
    updateOverlayTexture(material, pipeline?.target.target.texture ?? null)
  }, [material, pipeline, targetRevision])

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
