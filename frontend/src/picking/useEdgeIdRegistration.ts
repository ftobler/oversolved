import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'
import { bodyKeyFor } from './pickKey'
import type { EdgeData } from '@/types/cad'
import { buildEdgeSegmentGeometry, resolveEdgeQueries } from '@/components/Geometry3D/bodyGeometry'
import { isDevBuild } from '@/kernel/isDevBuild'

/**
 * Hook used by Body3D to register a body's edges with the edge ID layer.
 * No-op when the pipeline isn't mounted or the body has no edges.
 *
 * Edges are flattened to line segments using the same helper that produces
 * the visible LineSegments geometry, so the ID-buffer ribbons sit exactly
 * where the user sees the edges. Positions and segment map come from ONE
 * traversal (buildEdgeSegmentGeometry), so a skipped edge can never shift
 * every later segment onto the wrong edge query.
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
  const bodyKey = bodyKeyFor(featureId, bodyId)

  useRegisteredBody(pipeline, enabled, bodyKey,
    (p) => {
      if (!edges || edges.length === 0) return false
      // The padded query list Body3D's edge HighlightIndex counts from, so a
      // tail edge the kernel left unnamed picks where it highlights instead of
      // being highlight-only.
      const resolvedQueries = resolveEdgeQueries(edges, edgeQueries, bodyId)
      if (!resolvedQueries) return false
      const { positions: segmentPositions, segmentToEdge } = buildEdgeSegmentGeometry(edges)
      if (segmentPositions.length === 0) return false
      // Drift assert: positions and map come from one traversal, so any future
      // refactor that lets them disagree must fail here, not as silent
      // misattributed picks downstream (6 floats per segment).
      if (segmentToEdge.length * 6 !== segmentPositions.length) {
        throw new Error(
          `useEdgeIdRegistration: segmentToEdge length ${segmentToEdge.length} does not match `
          + `${segmentPositions.length / 6} built segments for ${bodyKey}`,
        )
      }
      try {
        p.edgeLayer.registerBody({ bodyKey, segmentPositions, segmentToEdge, edgeQueries: resolvedQueries, perPrimitivePickKeys: true })
        return true
      } catch (err) {
        if (isDevBuild()) console.warn('Edge ID registration failed; continuing without edge picking for this body', { bodyKey, err })
        return false
      }
    },
    (p) => p.edgeLayer.unregisterBody(bodyKey),
    [featureId, bodyId, edges, edgeQueries],
  )
}
