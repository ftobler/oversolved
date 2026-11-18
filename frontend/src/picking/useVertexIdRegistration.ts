import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredPart } from './idRegistrationUtils'
import { partKeyFor } from './pickKey'
import { resolveVertexQueries } from '@/components/Geometry3D/bodyGeometry'
import { isDevBuild } from '@/kernel/isDevBuild'

/**
 * Hook used by Body3D to register a body's vertices with the vertex ID
 * layer. No-op when the pipeline isn't mounted or the body has no vertices.
 */
export function useVertexIdRegistration(params: {
  featureId: string
  partId: string
  vertices: ReadonlyArray<[number, number, number]> | undefined
  vertexQueries: ReadonlyArray<string> | undefined
  enabled?: boolean
  // The body's sparse seam-vertex indices (BodyResult.hidden_vertices): not
  // drawn, so not pickable. Skipping the write keeps every other vertex's pick
  // id at its own index, the perPrimitivePickKeys contract.
  hiddenVertices?: ReadonlySet<number>
}): void {
  const pipeline = useIdPipeline()
  const { featureId, partId, vertices, vertexQueries, enabled = true, hiddenVertices } = params
  const partKey = partKeyFor(featureId, partId)

  useRegisteredPart(pipeline, enabled, partKey,
    (p) => {
      if (!vertices || vertices.length === 0) return false
      // The padded query list Body3D's vertex HighlightIndex counts from, so a
      // vertex the kernel left unnamed picks where it highlights.
      const resolvedQueries = resolveVertexQueries(vertices, vertexQueries, partId)
      if (!resolvedQueries) return false
      try {
        p.vertexLayer.registerPart({
          partKey, vertices, vertexQueries: resolvedQueries, perPrimitivePickKeys: true,
          hiddenIndices: hiddenVertices,
        })
        return true
      } catch (err) {
        if (isDevBuild()) console.warn('Vertex ID registration failed; continuing without vertex picking for this body', { bodyKey: partKey, err })
        return false
      }
    },
    (p) => p.vertexLayer.unregisterPart(partKey),
    [featureId, partId, vertices, vertexQueries, hiddenVertices],
  )
}
