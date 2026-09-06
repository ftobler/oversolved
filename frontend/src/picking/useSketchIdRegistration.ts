import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useIdPipeline } from './IdPipelineContext'
import type { Sketch, PlaneTransform, PartConstraint, Topology } from '@/types/cad'
import { planeTransformKey } from './planeTransformKey'
import { suppressedCoincidentVertexIds } from '@/components/Geometry3D/dragLogic'
import { inferredContactCandidates } from '@/components/Geometry3D/snapDetection'
import { buildPlaneMatrix } from './idRegistrationUtils'
import { buildSketchSegments, buildSketchVertices } from './sketchIdBuilders'


/**
 * Register a sketch's entities and vertices with the sketchEntity and
 * sketchVertex ID layers.
 *
 * Sketch entities are 2D in the sketch plane; the hook applies the plane
 * transform (rotation + origin) so the registered segments and vertex
 * centers sit at the same world positions as the visible
 * EntityLines/VertexDots geometry. The layer's shader then handles
 * screen-space fattening as usual.
 *
 * Composite-ID format matches the live store:
 *   entity composite:  `entity:${featureId}:${entityId}`
 *   vertex composite:  `vertex:${featureId}:${entityId}:${vertexKey}`
 * (See VertexDots.tsx:124 and EntityLines.tsx:21.)
 *
 * Inactive features (those not being edited) are still registered, so a
 * user can pick across other visible sketches. Suppressing those is a
 * caller decision via `enabled`.
 */

export function useSketchIdRegistration(params: {
  featureId: string
  sketch: Sketch | undefined
  planeTransform?: PlaneTransform
  enabled?: boolean
  constraints?: PartConstraint[]
  topology?: Topology
}): void {
  const pipeline = useIdPipeline()
  const { featureId, sketch, planeTransform, enabled = true, constraints, topology } = params

  // Build a stable matrix key from planeTransform so the hook re-runs when
  // the plane changes but not just because the prop reference shifts.
  const planeKey = useMemo(() => planeTransformKey(planeTransform), [planeTransform])

  // Constraint-backed coincident clusters: hide partner vertices so pick matches
  // the deduped render. Keyed off the constraints object identity.
  const suppressed = useMemo(
    () => suppressedCoincidentVertexIds(constraints ?? [], featureId),
    [constraints, featureId],
  )

  useEffect(() => {
    if (!enabled) return
    if (!pipeline) return
    if (!sketch || Object.keys(sketch).length === 0) return

    const m = buildPlaneMatrix(planeTransform)
    const seg = buildSketchSegments(featureId, sketch, m)
    const vtx = buildSketchVertices(featureId, sketch, m, suppressed)

    // Inferred contacts (tangencies + curve-curve intersections) register as
    // pickable 0-D handles in the vertex layer, carrying their `dock:`/`isect:`
    // query. Clicking one selects the handle; the constraint that names it
    // materializes a real point (lazy inferred materialization). `parseVertexKey`
    // returns null for these keys, so picking one never starts an entity drag --
    // it is select-only.
    const inferred = inferredContactCandidates(sketch, featureId, constraints ?? [], topology, 'active_sketch')
    if (inferred.length > 0) {
      const dv = new THREE.Vector3()
      for (const dc of inferred) {
        // Skip a non-finite contact position: the sketch vertex layer publishes
        // every mark position, and a NaN one buckets at the origin and reads as
        // coincident with every mark there (see VertexIdLayer / markPosition).
        if (!Number.isFinite(dc.position[0]) || !Number.isFinite(dc.position[1])) continue
        dv.set(dc.position[0], dc.position[1], 0).applyMatrix4(m)
        if (!Number.isFinite(dv.x) || !Number.isFinite(dv.y) || !Number.isFinite(dv.z)) continue
        vtx.vertices.push([dv.x, dv.y, dv.z])
        vtx.vertexQueries.push(dc.id)
      }
    }

    // Wrapped so a registerBody throw (24-bit ID exhaustion) does not escape the
    // effect: a passive-effect throw has no error boundary above it here and
    // would unmount the viewport root. The sibling surface hook already guards
    // this way.
    if (seg.edgeQueries.length > 0) {
      try {
        pipeline.sketchEntityLayer.registerBody({
          bodyKey: featureId,
          segmentPositions: seg.segmentPositions,
          segmentToEdge: seg.segmentToEdge,
          edgeQueries: seg.edgeQueries,
        })
      } catch (err) {
        console.warn('Sketch entity ID registration failed; continuing without it', { featureId, err })
      }
    }
    if (vtx.vertices.length > 0) {
      try {
        pipeline.sketchVertexLayer.registerBody({
          bodyKey: featureId,
          vertices: vtx.vertices,
          vertexQueries: vtx.vertexQueries,
        })
      } catch (err) {
        console.warn('Sketch vertex ID registration failed; continuing without it', { featureId, err })
      }
    }
    pipeline.markDirty()

    return () => {
      pipeline.sketchEntityLayer.unregisterBody(featureId)
      pipeline.sketchVertexLayer.unregisterBody(featureId)
      pipeline.markDirty()
    }
    // planeKey is the load-bearing dep for plane changes; planeTransform
    // object identity isn't. `constraints`/`topology` drive the inferred-contact
    // set (a new tangent or crossing adds a handle, materializing one removes it).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- planeTransform identity is intentionally excluded; see note above
  }, [pipeline, featureId, sketch, planeKey, enabled, suppressed, constraints, topology])
}
