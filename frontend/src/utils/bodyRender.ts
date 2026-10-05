// PURE LOGIC -- no Three.js, no React refs, no stores.
// The single source of the body-to-render selection shared by the part
// viewport and the assembly render computation. It lives here, below the UI
// tree, so the assembly render path can use it without importing
// `components/Viewport/bodyUtils`; that module re-exports these instead of
// keeping its own copy.
import type { Feature, BodyResult, EdgeData } from '@/types/cad'

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
