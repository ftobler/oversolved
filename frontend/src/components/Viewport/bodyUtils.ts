import type { Feature, SketchFeature, BodyResult, PartStyleEntry, Constraints, Sketch, SketchData } from '@/types/cad'
import { getBodiesToRender, isBodyHiddenByFeature } from '@/utils/bodyRender'
import type { BodyRenderItem } from '@/utils/bodyRender'
import { deriveConstraints, unflattenGeometry } from '@/utils/geometry/geometryMapping'
import { bodySnapSketches, builtinPlaneTransform } from '@/utils/geometry/bodySnapProjection'

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
// A hidden sketch's EntityLines and VertexDots are not mounted at all, so its
// ID-buffer registration cannot occlude or intercept picks on features behind it.
export function getSketchesToRender(
  features: Feature[] | undefined,
  rollbackPosition: number | undefined,
  visibleFeatures: Set<string> | undefined,
): SketchFeature[] {
  if (!features || features.length === 0) return []
  const limit = rollbackPosition ?? features.length
  return features
    .slice(0, limit)
    .filter((f): f is SketchFeature => f.kind === 'sketch' && (!visibleFeatures || visibleFeatures.has(f.id)))
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
  visibleFeatures?: ReadonlySet<string>,
): BodyRenderItem[] {
  // Feature visibility rides on the item already: a body a hidden feature made
  // stays out of the ghost layer too, so it cannot be picked through a row the
  // user has hidden.
  const items = getBodiesToRender(pickBodies, features, undefined, undefined, visibleFeatures)
  return items.map(item => {
    const visible = item.visible && partStyle?.[item.bodyId]?.visible !== false
    if (previewBodies && !(item.bodyId in previewBodies)) {
      return { ...item, visible, doomed: true }
    }
    return { ...item, visible }
  })
}

/**
 * The geometry a sketch renders: the solve's solved sketch and constraints when
 * a solve has landed, else the authored `initial` geometry unflattened into the
 * UI shape with its constraints derived from the feature. A sketch that has not
 * solved yet therefore still draws, and still shows the constraints the user
 * authored, instead of rendering empty.
 */
export function sketchForRender(
  solveResult: SketchData | undefined,
  featureDef: SketchFeature,
): { sketch: Sketch; constraints: Constraints } {
  const sketch = solveResult?.solved
    ? solveResult.solved
    : unflattenGeometry(featureDef.initial || {}, featureDef.entities)
  const constraints = solveResult?.constraints
    ? solveResult.constraints
    : deriveConstraints(featureDef, sketch)
  return { sketch, constraints }
}

/**
 * The cross-sketch snap set for the active sketch: other sketches plus the drawn
 * bodies projected onto the active sketch's plane. A body is projected as a
 * synthetic sketch under the `BODY_SNAP_FEAT_PREFIX` sentinel feature id, which
 * is how computeDragMutation tells a body snap from a real sketch constraint.
 *
 * Only drawn bodies contribute: `bodyItems` already applies the rollback bar and
 * the visibility row, so a hidden or not-yet-built body cannot offer a snap
 * target the user cannot see. When the plane or the body list is missing there
 * is nothing to project, and the plain other-sketch set is returned by identity
 * so the caller's memo sees no change.
 */
export function snapSketchesFor(
  otherSketches: Record<string, Sketch>,
  activeFeatureId: string | undefined,
  activeResult: SketchData | undefined,
  activeFeature: Feature | undefined,
  bodyItems: ReadonlyArray<BodyRenderItem>,
): Record<string, Sketch> {
  if (!activeFeatureId) return otherSketches
  // Kernel-provided when the sketch has solved, else derived from the builtin
  // plane string the feature names.
  const planeTransform = activeResult?.plane_transform
    ?? (activeFeature?.kind === 'sketch' && activeFeature.plane
      ? builtinPlaneTransform(activeFeature.plane)
      : null)
  if (!planeTransform || bodyItems.length === 0) return otherSketches

  const bodySketchEntries = bodySnapSketches(bodyItems, planeTransform)
  if (Object.keys(bodySketchEntries).length === 0) return otherSketches
  return { ...otherSketches, ...bodySketchEntries }
}

/** Returns bodies created by features at or after rollbackPosition (the "preview" bodies excluded by getBodiesToRender). */
export function getPreviewBodies(
  bodies: Record<string, BodyResult> | undefined,
  features: Feature[] | undefined,
  rollbackPosition: number | undefined,
  visibleBodies: Set<string> | undefined,
  visibleFeatures?: ReadonlySet<string>,
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
      // The edited feature is forced visible while its editor is open
      // (visibleFeatureIds), so its own preview body still shows even when the
      // user had hidden the feature before opening it.
      visible: (visibleBodies ? visibleBodies.has(bodyId) : true)
        && !isBodyHiddenByFeature(createdBy, features, visibleFeatures),

    })
  }
  return items
}
