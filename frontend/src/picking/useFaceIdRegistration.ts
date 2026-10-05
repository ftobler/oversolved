import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'
import { bodyKeyFor } from './pickKey'
import type { Mesh3D } from '@/types/cad'
import { buildBodyGeometry, faceCount, toNonIndexedPositions, resolveFaceQueries } from '@/components/Geometry3D/bodyGeometry'
import { isDevBuild } from '@/kernel/isDevBuild'

/**
 * Hook used by Body3D to register a body's per-face geometry with the
 * face ID layer. No-op when:
 *   - the pipeline isn't mounted (no <IdPickingDriver> in tree)
 *   - the mesh lacks stable face queries (no triangle_to_face / face_queries)
 *
 * The registration mirrors the visible geometry's non-indexed triangle
 * layout so each triangle's ID-buffer color is one face's packed ID.
 */
export function useFaceIdRegistration(params: {
  featureId: string
  bodyId: string
  mesh: Mesh3D
  enabled?: boolean
}): void {
  const pipeline = useIdPipeline()
  const { featureId, bodyId, mesh, enabled = true } = params
  const bodyKey = bodyKeyFor(featureId, bodyId)

  useRegisteredBody(pipeline, enabled, bodyKey,
    (p) => {
      // The padded query list Body3D's face HighlightIndex counts from, so the
      // ID-layer index space matches: a tail face with only a topo fallback is
      // pickable exactly when it is highlightable. Null (no face_queries, or
      // triangle_to_face missing or too short) leaves face picking unregistered
      // so it matches Body3D's legacy per-triangle highlight path for that mesh.
      const faceQueries = resolveFaceQueries(mesh, bodyId)
      if (!faceQueries) return false
      const { triangle_to_face } = mesh
      if (!triangle_to_face) return false
      const numTris = faceCount(mesh.faces)
      if (numTris === 0) return false
      const { positions, indices } = buildBodyGeometry(mesh)
      const nonIndexed = toNonIndexedPositions(positions, indices)
      const tri2face = triangle_to_face instanceof Uint32Array
        ? triangle_to_face
        : Uint32Array.from(triangle_to_face)
      try {
        p.faceLayer.registerBody({ bodyKey, positions: nonIndexed, triangleToFace: tri2face, faceQueries, perPrimitivePickKeys: true })
        return true
      } catch (err) {
        if (isDevBuild()) console.warn('Face ID registration failed; continuing without face picking for this body', { bodyKey, err })
        return false
      }
    },
    (p) => p.faceLayer.unregisterBody(bodyKey),
    [featureId, bodyId, mesh],
  )
}
