import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'

/**
 * Register the origin marker as a single pickable vertex.
 *
 * The originMarker ID layer runs at priority 45 with `depthTest=false`, so the
 * origin pick wins over any face/edge/plane/sketch-curve pixel directly behind
 * it -- matching the visible-pass on-top behavior set in #255. It deliberately
 * sits BELOW `sketchVertex`: see the ordering note at its construction in
 * `IdPipeline`.
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
