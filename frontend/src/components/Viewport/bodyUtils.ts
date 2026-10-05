import type { Feature, BodyResult, PartStyleEntry } from '@/types/cad'
import { getBodiesToRender } from '@/utils/bodyRender'
import type { BodyRenderItem } from '@/utils/bodyRender'

// `BodyRenderItem` and `getBodiesToRender` live in the utils leaf so the
// assembly render path can use them without importing the UI tree. They are
// re-exported here so the viewport callers keep their existing import site.
export { getBodiesToRender }
export type { BodyRenderItem }

/**
 * Computes which bodies should be visible given explicit user overrides.
 *
 * Returns undefined when there are no overrides (show everything).
 * Returns a Set (possibly empty) when at least one body has been explicitly
 * hidden, so that hidden bodies stay hidden instead of snapping back.
 */
export function computeEffectiveVisibleBodies(
  bodies: Record<string, BodyResult> | undefined,
  _visibleFeatures: Set<string>,
  partStyle: Record<string, PartStyleEntry>,
): Set<string> | undefined {
  const visible = new Set<string>()
  let anyExplicitHide = false
  for (const bodyId of Object.keys(bodies || {})) {
    if (partStyle[bodyId]?.visible === false) {
      anyExplicitHide = true
      continue
    }
    visible.add(bodyId)
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

/**
 * Ghost items: the body state from before the edited feature, drawn behind the
 * preview. Rollback is deliberately not applied -- the user picks references off
 * every prior body.
 *
 * A body the edited feature removes (delete_body, or a boolean that swallows its
 * tool) is marked `doomed` rather than hidden. It used to be hidden, but
 * that told the user nothing about WHICH body was leaving, and it dropped the
 * body out of the id buffer (Body3D gates its registrations on `visible`), so
 * the toggle in `add_delete_body_ref` could never fire a second time and the
 * pick could not be undone from the viewport.
 *
 * Visibility here is read from `partStyle` and NOT from the `visibleBodies` set
 * the solid layer uses. That set is derived from the PREVIEW bodies
 * (computeEffectiveVisibleBodies in Part.tsx), so for the ghost layer it
 * conflates the two axes: a body the edit removes is simply missing from it,
 * exactly like a body the user hid, and it collapses to "show everything" as
 * soon as the preview leaves no body at all. partStyle is the user's axis
 * alone, which is the only one `visible` may express.
 */
export function getGhostBodiesToRender(
  pickBodies: Record<string, BodyResult> | undefined,
  previewBodies: Record<string, BodyResult> | undefined,
  features: Feature[] | undefined,
  partStyle: Record<string, PartStyleEntry> | undefined,
): BodyRenderItem[] {
  const items = getBodiesToRender(pickBodies, features, undefined, undefined)
  return items.map(item => {
    const visible = partStyle?.[item.bodyId]?.visible !== false
    if (previewBodies && !(item.bodyId in previewBodies)) {
      return { ...item, visible, doomed: true }
    }
    return { ...item, visible }
  })
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
