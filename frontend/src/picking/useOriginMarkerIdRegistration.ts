import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'

/**
 * Register the origin marker as a single pickable vertex.
 *
 * The originMarker ID layer is the highest-priority layer in the pipeline
 * (priority=60) with `depthTest=false`, so the origin pick wins over any
 * face/edge/vertex/plane/sketch pixel directly behind it -- matching the
 * visible-pass on-top behavior set in #255.
 */
export function useOriginMarkerIdRegistration(params: {
  selectionId: string
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { selectionId, enabled = true } = params

  useRegisteredBody(pipeline, enabled, selectionId,
    (p) => {
      p.originLayer.registerBody({
        bodyKey: selectionId,
        vertices: [[0, 0, 0]],
        vertexQueries: [selectionId],
      })
      return true
    },
    (p) => p.originLayer.unregisterBody(selectionId),
    [selectionId],
  )
}
