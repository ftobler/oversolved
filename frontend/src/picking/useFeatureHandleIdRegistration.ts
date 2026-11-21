import { useEffect, useMemo } from 'react'
import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredPart } from './idRegistrationUtils'
import { FEATURE_HANDLE_LAYER_NAME } from './layerNames'
import { polylinePickable } from './probeMarks'
import { clearProbeSource, probeSourceKeys, replaceProbeSource } from './sceneProbeStore'
import { isDevBuild } from '@/kernel/isDevBuild'
import type { Vec3 } from '@/utils/vec3'

/** Selection-id key for a feature editing handle. */
export function featureHandleKey(featureId: string, field: string): string {
  return `fhandle:${featureId}:${field}`
}

type FeatureHandleIdentity =
  | { featureId: string; field: string; key?: undefined }
  // A handle whose key is already canonical in its own module (the section's
  // rings use `section:ring:<angle>`), rather than feature/field shaped.
  | { key: string; featureId?: undefined; field?: undefined }

interface FeatureHandleGeometry {
  // The arrow's tail and tip, in world space.
  start?: Vec3
  end?: Vec3
  // A closed chain of world points, registered as consecutive segments under
  // ONE key. A ring is one grab target, not one per sampled segment, so the
  // resolver's window and the hover/selection id stay per-handle.
  points?: ReadonlyArray<Vec3>
  enabled?: boolean
}

/**
 * Register a feature editing handle into the featureHandle ID layer.
 *
 * The layer is priority=80 / no-depth, so the handle's pixels win over every
 * other layer, matching the always-on-top drawing. The handle is one or more
 * line segments: an arrow registers its tail-to-tip segment, a ring its closed
 * chain. The resolver's snap window then gives the whole handle the same grab
 * slop a vertex point gets, instead of only one point on a much longer visual.
 */
export function useFeatureHandleIdRegistration(
  params: FeatureHandleIdentity & FeatureHandleGeometry,
): void {
  const pipeline = useIdPipeline()
  const { enabled = true } = params
  const entityKey = params.key !== undefined
    ? params.key
    : featureHandleKey(params.featureId, params.field)

  // Scalars keep the arrow's effect stable across renders that hand in a fresh
  // array; the ring path passes a memoized chain.
  const [sx, sy, sz] = params.start ?? [0, 0, 0]
  const [ex, ey, ez] = params.end ?? [0, 0, 0]
  const points = params.points

  const geometry = useMemo(() => {
    const chain: ReadonlyArray<Vec3> = points ?? [[sx, sy, sz], [ex, ey, ez]]
    if (chain.length < 2) return null
    const positions = new Float32Array((chain.length - 1) * 6)
    for (let i = 0; i < chain.length - 1; i++) {
      positions.set(chain[i], i * 6)
      positions.set(chain[i + 1], i * 6 + 3)
    }
    return { chain, positions }
  }, [points, sx, sy, sz, ex, ey, ez])

  const registered = enabled && geometry !== null

  // The probe publishes the same segments the layer registers.
  useEffect(() => {
    if (!registered || !geometry) return
    const probeKey = probeSourceKeys.featureHandle(entityKey)
    replaceProbeSource(probeKey, [
      polylinePickable(FEATURE_HANDLE_LAYER_NAME, entityKey, geometry.chain),
    ])
    return () => clearProbeSource(probeKey)
  }, [registered, entityKey, geometry])

  useRegisteredPart(
    pipeline,
    registered,
    entityKey,
    (p) => {
      if (!geometry) return false
      try {
        p.featureHandleLayer.registerPart({
          partKey: entityKey,
          segmentPositions: geometry.positions,
          segmentToEdge: new Array(geometry.chain.length - 1).fill(0),
          edgeQueries: [entityKey],
        })
        return true
      } catch (err) {
        // No error boundary above a passive effect throw here: a registerBody
        // failure would unmount the viewport root. Warn and return false, as
        // the body hooks do; useRegisteredBody skips markDirty on false.
        if (isDevBuild()) console.warn('Feature handle ID registration failed; continuing without it', { entityKey, err })
        return false
      }
    },
    (p) => p.featureHandleLayer.unregisterPart(entityKey),
    [geometry],
  )
}
