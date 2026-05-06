import type { Feature, BodyResult, EdgeData } from '../../types/cad'

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
  ghost: boolean
}

function isInActiveRange(id: string, features: Feature[] | undefined, rollbackPos: number | undefined): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  if (idx < 0) return false
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

    items.push({
      key: bodyId,
      featureId: createdBy,
      bodyId,
      mesh: body.mesh,
      edges: body.edges ?? [],
      edgeQueries: body.edge_queries,
      vertices: body.vertices,
      vertexQueries: body.vertex_queries,
      visible: visibleBodies ? visibleBodies.has(bodyId) : true,
      ghost: false,
    })
  }
  return items
}