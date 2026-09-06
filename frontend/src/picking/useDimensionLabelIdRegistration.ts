import { useMemo } from 'react'
import * as THREE from 'three'
import { useIdPipeline } from './IdPipelineContext'
import type { PlaneTransform } from '@/types/cad'
import { buildPlaneMatrix, useRegisteredBody } from './idRegistrationUtils'
import { planeTransformKey } from './planeTransformKey'

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

  // Keyed on the plane's VALUE, not the prop reference: an equal-valued fresh
  // PlaneTransform per render must not re-register (mirrors the two sketch
  // hooks). The Matrix4 is rebuilt only when the key changes and the key, not
  // the Matrix4, is the effect dep.
  const planeKey = useMemo(() => planeTransformKey(planeTransform), [planeTransform])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- planeKey stands in for planeTransform's value; see note above
  const matrix = useMemo(() => buildPlaneMatrix(planeTransform), [planeKey])

  const entityKey = sub ? `dim:${constraintId}:${sub}` : `dim:${constraintId}`

  useRegisteredBody(
    pipeline,
    enabled,
    entityKey,
    (p) => {
      const v = new THREE.Vector3(px, py, pz).applyMatrix4(matrix)
      try {
        p.dimensionLabelLayer.registerBody({
          bodyKey: entityKey,
          vertices: [[v.x, v.y, v.z]],
          vertexQueries: [entityKey],
        })
        return true
      } catch (err) {
        // A passive-effect registerBody throw has no error boundary above it and
        // would unmount the viewport root. Warn and return false like the body
        // hooks; useRegisteredBody skips markDirty on false.
        console.warn('Dimension label ID registration failed; continuing without it', { entityKey, err })
        return false
      }
    },
    (p) => p.dimensionLabelLayer.unregisterBody(entityKey),
    [px, py, pz, planeKey],
  )
}
