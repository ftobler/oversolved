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
      try {
        p.originLayer.registerBody({
          bodyKey: selectionId,
          vertices: [[0, 0, 0]],
          vertexQueries: [selectionId],
        })
        return true
      } catch (err) {
        // A registerBody throw (24-bit ID exhaustion) in a passive effect
        // escalates to the nearest error boundary, and there is none: the whole
        // viewport root would unmount. Swallow it like the body hooks do;
        // useRegisteredBody skips markDirty on false.
        console.warn('Origin marker ID registration failed; continuing without it', { selectionId, err })
        return false
      }
    },
    (p) => p.originLayer.unregisterBody(selectionId),
    [selectionId],
  )
}
