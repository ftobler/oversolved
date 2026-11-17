// PURE LOGIC -- no Three.js, no React refs, no stores.
// The single source of the body-to-render selection shared by the part
// viewport and the assembly render computation. It lives here, below the UI
// tree, so the assembly render path can use it without importing
// `components/Viewport/bodyUtils`; that module re-exports these instead of
// keeping its own copy.
import type { Feature, PartResult, EdgeData } from '@/types/cad'

export interface PartRenderItem {
  key: string
  featureId: string
  partId: string
  mesh: NonNullable<PartResult['mesh']>
  edges: EdgeData[]
  edgeQueries?: string[]
  // Per-edge creating feature, for the viewport's relation hint (Body3D reads
  // it to tint the wireframe of a selected feature).
  edgeCreatedBy?: string[]
  vertices?: [number, number, number][]
  vertexQueries?: string[]
  // The kernel's sparse display-only indices (BodyResult.hidden_edges /
  // hidden_vertices): the viewport neither draws nor picks them.
  hiddenEdges?: number[]
  hiddenVertices?: number[]
  visible: boolean
  // Ghost layer only: the edit being previewed consumes this body. Orthogonal to
  // `visible`, which is the user's own show/hide -- a doomed body the user hid
  // stays hidden.
  doomed?: boolean
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

/**
 * Whether the feature that created a body is hidden in the tree. A
 * body-producing feature's eye writes `visible: false` on the feature (the same
 * mutation a sketch or plane uses), and this is the read that turns it into
 * hidden bodies: the feature owns what it made, without a per-body write and
 * without touching bodies a later feature modified in place.
 *
 * A creator the feature log does not know stays drawn, the same liveness rule
 * `isInActiveRange` uses. That keeps imported and legacy bodies visible; an
 * unresolved creator is not a user hide.
 */
export function isPartHiddenByFeature(
  createdBy: string | undefined,
  features: Feature[] | undefined,
  visibleFeatures: ReadonlySet<string> | undefined,
): boolean {
  if (!visibleFeatures || !createdBy) return false
  if (!features?.some(f => f.id === createdBy)) return false
  return !visibleFeatures.has(createdBy)
}

export function getPartsToRender(
  parts: Record<string, PartResult> | undefined,
  features: Feature[] | undefined,
  rollbackPosition: number | undefined,
  visibleParts: Set<string> | undefined,
  visibleFeatures?: ReadonlySet<string>,
): PartRenderItem[] {
  const items: PartRenderItem[] = []
  if (!parts) return items

  for (const [bodyId, body] of Object.entries(parts)) {
    const createdBy = body.created_by
    if (!isInActiveRange(createdBy, features, rollbackPosition)) continue
    if (!body.mesh) continue
    const featureId = createdBy || bodyId
    const partVisible = visibleParts ? visibleParts.has(bodyId) : true

    items.push({
      key: bodyId,
      featureId,
      partId: bodyId,
      mesh: body.mesh,
      edges: body.edges ?? [],
      edgeQueries: body.edge_queries,
      edgeCreatedBy: body.edge_created_by,
      vertices: body.vertices,
      vertexQueries: body.vertex_queries,
      hiddenEdges: body.hidden_edges,
      hiddenVertices: body.hidden_vertices,
      visible: partVisible && !isPartHiddenByFeature(createdBy, features, visibleFeatures),
    })
  }
  return items
}
