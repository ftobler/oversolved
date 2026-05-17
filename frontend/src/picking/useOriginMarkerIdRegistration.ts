import { useEffect } from 'react'
import { useIdPipeline } from './IdPipelineContext'

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
  // The origin marker is by definition at the world origin. Hardcoded so
  // callers can't accidentally drift the pickable point from the visible Dot.
  const px = 0, py = 0, pz = 0

  useEffect(() => {
    if (!enabled) return
    if (!pipeline) return
    pipeline.originLayer.registerBody({
      bodyKey: selectionId,
      vertices: [[px, py, pz]],
      vertexQueries: [selectionId],
    })
    pipeline.markDirty()
    return () => {
      pipeline.originLayer.unregisterBody(selectionId)
      pipeline.markDirty()
    }
  }, [pipeline, selectionId, px, py, pz, enabled])
}
