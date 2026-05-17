import { useEffect } from 'react'
import { useIdPipeline } from './IdPipelineContext'

/**
 * Register a dimension label hit circle into the dimensionLabel ID layer.
 *
 * Sub-key disambiguates multiple hit circles owned by the same constraint
 * (e.g. a two-radius dimension). When omitted, the entity key is
 * `dim:<constraintId>`; otherwise `dim:<constraintId>:<sub>`.
 *
 * The layer is priority=70 with depthTest=false, so a label pixel wins
 * over every other layer where it draws -- matching the visible-pass
 * always-on-top placement of the label Html (z=0.001) + opaque hit mesh.
 */
export function useDimensionLabelIdRegistration(params: {
  constraintId: string
  position: [number, number, number]
  sub?: string
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { constraintId, position, sub, enabled = true } = params
  const [px, py, pz] = position

  useEffect(() => {
    if (!enabled) return
    if (!pipeline) return
    const entityKey = sub
      ? `dim:${constraintId}:${sub}`
      : `dim:${constraintId}`
    const bodyKey = entityKey
    pipeline.dimensionLabelLayer.registerBody({
      bodyKey,
      vertices: [[px, py, pz]],
      vertexQueries: [entityKey],
    })
    pipeline.markDirty()
    return () => {
      pipeline.dimensionLabelLayer.unregisterBody(bodyKey)
      pipeline.markDirty()
    }
  }, [pipeline, constraintId, sub, px, py, pz, enabled])
}
