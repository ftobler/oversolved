import type { BodyResult, Feature, PlaneDef } from '@/types/cad'
import { computeVertexBounds } from '@/components/Viewport/cameraController'
import { DEFAULT_PLANE_SIZE } from '@/components/Viewport/planeConstants'

// Plane sizing and the active-sketch-plane lookup are pure (geometry and
// feature lists in, a number or query string out). They live in this leaf so
// the sizing tiers stay unit testable if the Viewport Canvas tree is deleted;
// the component that renders the sketch plane is in SketchPlaneDisplay.tsx.

export function calculateMeshExtentFromFlat(vertices: Float32Array): number {
  const bounds = computeVertexBounds(vertices)
  if (!bounds) return 0
  return Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  )
}

export function calculateMeshExtent(vertices: Float32Array | [number, number, number][]): number {
  const bounds = computeVertexBounds(vertices)
  if (!bounds) return 0
  return Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  )
}

export function getModelBoundingBoxExtent(bodies: Record<string, BodyResult> | undefined): number {
  if (!bodies) return 0

  let maxExtent = 0
  for (const body of Object.values(bodies)) {
    if (body.mesh?.vertices) {
      const e = calculateMeshExtent(body.mesh.vertices)
      if (e > maxExtent) maxExtent = e
    }
  }

  return maxExtent
}

export function getFaceExtent(faceQuery: string, bodies: Record<string, BodyResult>): number {
  const match = faceQuery.match(/@([^/]+)/)
  if (!match) return 0

  const bodyId = match[1]
  const body = bodies[bodyId]
  if (!body?.mesh?.vertices) return 0

  return calculateMeshExtent(body.mesh.vertices)
}

export function calculatePlaneSize(
  planeDefinition: PlaneDef | undefined,
  bodies: Record<string, BodyResult> | undefined,
): number {
  const EXPANSION_FACTOR = 1.1

  if (!planeDefinition || !bodies) return DEFAULT_PLANE_SIZE

  // Plane defined on a face (on_face mode)
  if (planeDefinition.mode === 'on_face' && planeDefinition.face) {
    const faceExtent = getFaceExtent(planeDefinition.face, bodies)
    if (faceExtent > 0) return faceExtent * EXPANSION_FACTOR
  }

  // Fallback: use model bounding box
  const modelExtent = getModelBoundingBoxExtent(bodies)
  if (modelExtent > 0) return modelExtent * EXPANSION_FACTOR

  // Final fallback
  return DEFAULT_PLANE_SIZE
}

export function getActiveSketchPlane(
  activeFeatureId: string | null | undefined,
  features: Feature[] | undefined,
): string | null {
  if (!activeFeatureId || !features) return null
  const activeFeature = features.find(f => f.id === activeFeatureId)
  if (!activeFeature || activeFeature.kind !== 'sketch') return null
  return activeFeature.plane || null
}
