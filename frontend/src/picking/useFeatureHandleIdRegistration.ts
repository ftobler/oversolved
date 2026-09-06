import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'

/** Selection-id key for a feature editing handle. */
export function featureHandleKey(featureId: string, field: string): string {
  return `fhandle:${featureId}:${field}`
}

/**
 * Register a feature editing handle's arrow into the featureHandle ID layer
 * as a single line segment from the arrow tail to its tip, both world space
 * (handles are not sketch-plane objects). The layer is priority=80 /
 * no-depth, so the arrow's pixels win over every other layer -- matching the
 * always-on-top visible arrow. The resolver's snap window then gives the
 * whole arrow the same grab slop a vertex point gets, instead of only one
 * point on a much longer visual.
 */
export function useFeatureHandleIdRegistration(params: {
  featureId: string
  field: string
  start: [number, number, number]
  end: [number, number, number]
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { featureId, field, enabled = true } = params
  const [sx, sy, sz] = params.start
  const [ex, ey, ez] = params.end

  const entityKey = featureHandleKey(featureId, field)

  useRegisteredBody(
    pipeline,
    enabled,
    entityKey,
    (p) => {
      try {
        p.featureHandleLayer.registerBody({
          bodyKey: entityKey,
          segmentPositions: new Float32Array([sx, sy, sz, ex, ey, ez]),
          segmentToEdge: [0],
          edgeQueries: [entityKey],
        })
        return true
      } catch (err) {
        // No error boundary above a passive effect throw here: a registerBody
        // failure would unmount the viewport root. Warn and return false, as
        // the body hooks do; useRegisteredBody skips markDirty on false.
        console.warn('Feature handle ID registration failed; continuing without it', { entityKey, err })
        return false
      }
    },
    (p) => p.featureHandleLayer.unregisterBody(entityKey),
    [sx, sy, sz, ex, ey, ez],
  )
}
