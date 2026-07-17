import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'

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
  const bodyKey = `${featureId}/${bodyId}`

  useRegisteredBody(pipeline, enabled, bodyKey,
    (p) => {
      if (!vertices || vertices.length === 0 || !vertexQueries || vertexQueries.length === 0) return false
      try {
        p.vertexLayer.registerBody({ bodyKey, vertices, vertexQueries, perPrimitivePickKeys: true })
        return true
      } catch (err) {
        console.warn('Vertex ID registration failed; continuing without vertex picking for this body', { bodyKey, err })
        return false
      }
    },
    (p) => p.vertexLayer.unregisterBody(bodyKey),
    [featureId, bodyId, vertices, vertexQueries],
  )
}
