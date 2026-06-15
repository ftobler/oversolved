import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'
import type { EdgeData } from '@/types/cad'
import { buildEdgeSegments, getEdgeSegmentCounts } from '@/components/Geometry3D/bodyGeometry'

/**
 * Hook used by Body3D to register a body's edges with the edge ID layer.
 * No-op when the pipeline isn't mounted or the body has no edges.
 *
 * Edges are flattened to line segments using the same helper that produces
 * the visible LineSegments geometry, so the ID-buffer ribbons sit exactly
 * where the user sees the edges.
 */
export function useEdgeIdRegistration(params: {
  featureId: string
  bodyId: string
  edges: EdgeData[] | undefined
  edgeQueries: ReadonlyArray<string> | undefined
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { featureId, bodyId, edges, edgeQueries, enabled = true } = params
  const bodyKey = `${featureId}/${bodyId}`

  useRegisteredBody(pipeline, enabled, bodyKey,
    (p) => {
      if (!edges || edges.length === 0 || !edgeQueries || edgeQueries.length === 0) return false
      const segmentPositions = buildEdgeSegments(edges)
      if (segmentPositions.length === 0) return false
      const segCounts = getEdgeSegmentCounts(edges)
      const totalSegments = segCounts.reduce((a, b) => a + b, 0)
      const segmentToEdge = new Uint32Array(totalSegments)
      let cursor = 0
      for (let edgeIdx = 0; edgeIdx < segCounts.length; edgeIdx++) {
        const count = segCounts[edgeIdx]
        for (let i = 0; i < count; i++) segmentToEdge[cursor++] = edgeIdx
      }
      try {
        p.edgeLayer.registerBody({ bodyKey, segmentPositions, segmentToEdge, edgeQueries })
        return true
      } catch (err) {
        console.warn('Edge ID registration failed; continuing without edge picking for this body', { bodyKey, err })
        return false
      }
    },
    (p) => p.edgeLayer.unregisterBody(bodyKey),
    [featureId, bodyId, edges, edgeQueries],
  )
}
