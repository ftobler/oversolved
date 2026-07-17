import { useIdPipeline } from './IdPipelineContext'
import { useRegisteredBody } from './idRegistrationUtils'
import type { Mesh3D } from '@/types/cad'
import { buildBodyGeometry, faceCount } from '@/components/Geometry3D/bodyGeometry'

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
  const bodyKey = `${featureId}/${bodyId}`

  useRegisteredBody(pipeline, enabled, bodyKey,
    (p) => {
      const { triangle_to_face, face_queries } = mesh
      if (!triangle_to_face || !face_queries || face_queries.length === 0) return false
      const numTris = faceCount(mesh.faces)
      if (numTris === 0) return false
      const { positions, indices } = buildBodyGeometry(mesh)
      const nonIndexed = new Float32Array(indices.length * 3)
      for (let i = 0; i < indices.length; i++) {
        const vi = indices[i] * 3
        nonIndexed[i * 3]     = positions[vi]
        nonIndexed[i * 3 + 1] = positions[vi + 1]
        nonIndexed[i * 3 + 2] = positions[vi + 2]
      }
      const tri2face = triangle_to_face instanceof Uint32Array
        ? triangle_to_face
        : Uint32Array.from(triangle_to_face)
      try {
        p.faceLayer.registerBody({ bodyKey, positions: nonIndexed, triangleToFace: tri2face, faceQueries: face_queries, perPrimitivePickKeys: true })
        return true
      } catch (err) {
        console.warn('Face ID registration failed; continuing without face picking for this body', { bodyKey, err })
        return false
      }
    },
    (p) => p.faceLayer.unregisterBody(bodyKey),
    [featureId, bodyId, mesh],
  )
}
