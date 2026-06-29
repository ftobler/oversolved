import { useMemo } from 'react'
import * as THREE from 'three'
import { useIdPipeline } from './IdPipelineContext'
import type { PlaneTransform } from '@/types/cad'
import { buildPlaneMatrix, useRegisteredBody } from './idRegistrationUtils'

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
 *
 * `position` is in local sketch 2D coordinates. If `planeTransform` is
 * provided the position is transformed to world space before registration,
 * so the hit area matches the visual label on non-XY-plane sketches.
 */
export function useDimensionLabelIdRegistration(params: {
  constraintId: string
  position: [number, number, number]
  sub?: string
  enabled?: boolean
  planeTransform?: PlaneTransform
}): void {
  const pipeline = useIdPipeline()
  const { constraintId, position, sub, enabled = true, planeTransform } = params
  const [px, py, pz] = position

  const matrix = useMemo(() => buildPlaneMatrix(planeTransform), [planeTransform])

  const entityKey = sub ? `dim:${constraintId}:${sub}` : `dim:${constraintId}`

  useRegisteredBody(
    pipeline,
    enabled,
    entityKey,
    (p) => {
      const v = new THREE.Vector3(px, py, pz).applyMatrix4(matrix)
      p.dimensionLabelLayer.registerBody({
        bodyKey: entityKey,
        vertices: [[v.x, v.y, v.z]],
        vertexQueries: [entityKey],
      })
      return true
    },
    (p) => p.dimensionLabelLayer.unregisterBody(entityKey),
    [px, py, pz, matrix],
  )
}
