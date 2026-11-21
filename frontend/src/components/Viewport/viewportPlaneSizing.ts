import type { PartResult, Feature, PlaneDef } from '@/types/cad'
import { computeVertexBounds } from '@/utils/geometry/vertexBounds'
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

export function getModelBoundingBoxExtent(parts: Record<string, PartResult> | undefined): number {
  if (!parts) return 0

  let maxExtent = 0
  for (const part of Object.values(parts)) {
    if (part.mesh?.vertices) {
      const e = calculateMeshExtent(part.mesh.vertices)
      if (e > maxExtent) maxExtent = e
    }
  }

  return maxExtent
}

export function getFaceExtent(faceQuery: string, parts: Record<string, PartResult>): number {
  const match = faceQuery.match(/@([^/]+)/)
  if (!match) return 0

  const partId = match[1]
  const part = parts[partId]
  if (!part?.mesh?.vertices) return 0

  return calculateMeshExtent(part.mesh.vertices)
}

export function calculatePlaneSize(
  planeDefinition: PlaneDef | undefined,
  parts: Record<string, PartResult> | undefined,
): number {
  const EXPANSION_FACTOR = 1.1

  if (!planeDefinition || !parts) return DEFAULT_PLANE_SIZE

  // Plane defined on a face (on_face mode)
  if (planeDefinition.mode === 'on_face' && planeDefinition.face) {
    const faceExtent = getFaceExtent(planeDefinition.face, parts)
    if (faceExtent > 0) return faceExtent * EXPANSION_FACTOR
  }

  // Fallback: use model bounding box
  const modelExtent = getModelBoundingBoxExtent(parts)
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
