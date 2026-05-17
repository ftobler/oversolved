import type { Feature, BodyResult, EdgeData, PartStyleEntry } from '@/types/cad'

/**
 * Computes which bodies should be visible given explicit user overrides and
 * feature-level visibility.
 *
 * Returns undefined when there are no overrides (show everything).
 * Returns a Set (possibly empty) when at least one body has been explicitly
 * hidden, so that hidden bodies stay hidden instead of snapping back.
 */
export function computeEffectiveVisibleBodies(
  bodies: Record<string, BodyResult> | undefined,
  visibleFeatures: Set<string>,
  partStyle: Record<string, PartStyleEntry>,
): Set<string> | undefined {
  const visible = new Set<string>()
  let anyExplicitHide = false
  for (const [bodyId, body] of Object.entries(bodies || {})) {
    if (partStyle[bodyId]?.visible === false) {
      anyExplicitHide = true
      continue
    }
    if (body.created_by && visibleFeatures.has(body.created_by)) {
      visible.add(bodyId)
    }
  }
  return (visible.size > 0 || anyExplicitHide) ? visible : undefined
}

// Returns the subset of sketch features that should be rendered (visible and within rollback range).
// A hidden sketch's EntityLines and VertexDots are not mounted at all, so its collision
// geometry cannot interfere with raycasting against features behind it.
export function getSketchesToRender(
  features: Feature[] | undefined,
  rollbackPosition: number | undefined,
  visibleFeatures: Set<string> | undefined,
): Feature[] {
  if (!features || features.length === 0) return []
  const limit = rollbackPosition ?? features.length
  return features
    .slice(0, limit)
    .filter(f => f.kind === 'sketch' && (!visibleFeatures || visibleFeatures.has(f.id)))
}

export interface BodyRenderItem {
  key: string
  featureId: string
  bodyId: string
  mesh: NonNullable<BodyResult['mesh']>
  edges: EdgeData[]
  edgeQueries?: string[]
  vertices?: [number, number, number][]
  vertexQueries?: string[]
  visible: boolean
}

function isInActiveRange(id: string, features: Feature[] | undefined, rollbackPos: number | undefined): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  // Keep rendering bodies even when `created_by` can't be resolved
  // (e.g. imported/legacy payloads). Hiding unknown creators can blank
  // the viewport despite valid body meshes.
  if (idx < 0) return true
  return rollbackPos === undefined || idx < rollbackPos
}

export function getBodiesToRender(
  bodies: Record<string, BodyResult> | undefined,
  features: Feature[] | undefined,
  rollbackPosition: number | undefined,
  visibleBodies: Set<string> | undefined,
): BodyRenderItem[] {
  const items: BodyRenderItem[] = []
  if (!bodies) return items

  for (const [bodyId, body] of Object.entries(bodies)) {
    const createdBy = body.created_by
    if (!isInActiveRange(createdBy, features, rollbackPosition)) continue
    if (!body.mesh) continue
    const featureId = createdBy || bodyId

    items.push({
      key: bodyId,
      featureId,
      bodyId,
      mesh: body.mesh,
      edges: body.edges ?? [],
      edgeQueries: body.edge_queries,
      vertices: body.vertices,
      vertexQueries: body.vertex_queries,
      visible: visibleBodies ? visibleBodies.has(bodyId) : true,

    })
  }
  return items
}

/** Returns bodies created by features at or after rollbackPosition (the "preview" bodies excluded by getBodiesToRender). */
export function getPreviewBodies(
  bodies: Record<string, BodyResult> | undefined,
  features: Feature[] | undefined,
  rollbackPosition: number | undefined,
  visibleBodies: Set<string> | undefined,
): BodyRenderItem[] {
  const items: BodyRenderItem[] = []
  if (!bodies || rollbackPosition === undefined) return items

  // enterEditFeature sets rollbackPosition = idx + 1, so bodies from idx
  // onwards are the preview (the edited feature and everything after it).
  const previewFrom = Math.max(0, rollbackPosition - 1)

  for (const [bodyId, body] of Object.entries(bodies)) {
    const createdBy = body.created_by
    const featureId = createdBy || bodyId
    const idx = features?.findIndex(f => f.id === createdBy) ?? -1
    // Unknown creator ids are treated as non-preview so bodies remain visible.
    if (idx >= 0 && idx < previewFrom) continue
    if (!body.mesh) continue

    items.push({
      key: bodyId,
      featureId,
      bodyId,
      mesh: body.mesh,
      edges: body.edges ?? [],
      edgeQueries: body.edge_queries,
      vertices: body.vertices,
      vertexQueries: body.vertex_queries,
      visible: visibleBodies ? visibleBodies.has(bodyId) : true,

    })
  }
  return items
}
