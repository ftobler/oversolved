import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'

/** Selection-id key for a feature editing handle. */
export function featureHandleKey(featureId: string, field: string): string {
  return `fhandle:${featureId}:${field}`
}

/**
 * Register a feature editing handle's grab point into the featureHandle ID
 * layer. `position` is world space (handles are not sketch-plane objects).
 * The layer is priority=80 / no-depth, so the grab pixel wins over every
 * other layer -- matching the always-on-top visible arrow.
 */
export function useFeatureHandleIdRegistration(params: {
  featureId: string
  field: string
  position: [number, number, number]
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { featureId, field, enabled = true } = params
  const [px, py, pz] = params.position

  const entityKey = featureHandleKey(featureId, field)

  useRegisteredBody(
    pipeline,
    enabled,
    entityKey,
    (p) => {
      p.featureHandleLayer.registerBody({
        bodyKey: entityKey,
        vertices: [[px, py, pz]],
        vertexQueries: [entityKey],
      })
      return true
    },
    (p) => p.featureHandleLayer.unregisterBody(entityKey),
    [px, py, pz],
  )
}
