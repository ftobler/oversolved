import { useEffect } from 'react'
import { useIdPipeline } from './IdPipelineContext'

/**
 * Hook used by Body3D to register a body's vertices with the vertex ID
 * layer. No-op when the pipeline isn't mounted or the body has no vertices.
 */
export function useVertexIdRegistration(params: {
  featureId: string
  bodyId: string
  vertices: ReadonlyArray<[number, number, number]> | undefined
  vertexQueries: ReadonlyArray<string> | undefined
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { featureId, bodyId, vertices, vertexQueries, enabled = true } = params

  useEffect(() => {
    if (!enabled) return
    if (!pipeline) return
    if (!vertices || vertices.length === 0) return
    if (!vertexQueries || vertexQueries.length === 0) return

    const bodyKey = `${featureId}/${bodyId}`
    try {
      pipeline.vertexLayer.registerBody({ bodyKey, vertices, vertexQueries })
      pipeline.markDirty()
    } catch (err) {
      // Picking must never break visible rendering.
      console.warn('Vertex ID registration failed; continuing without vertex picking for this body', { bodyKey, err })
      return
    }

    return () => {
      pipeline.vertexLayer.unregisterBody(bodyKey)
      pipeline.markDirty()
    }
  }, [pipeline, featureId, bodyId, vertices, vertexQueries, enabled])
}
