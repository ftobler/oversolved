// The split tool: hover a sketch curve, see where it would be cut, click to cut
// it there. The pure half (which entity, which point, which mutation, why not)
// lives here so it is testable without the viewport; the marker component only
// feeds it the hover and draws what it answers.
//
// The point is snapped the way the draw tools snap: a hovered vertex or
// inferred contact (an intersection, a dock) owns the point when it lies on the
// curve the cursor was last over, else the cursor's foot on the hovered curve.
// A circle needs two points, so its first click is held as a pending point and
// the second click cuts.

import type { Point, Mutation, SketchFeature } from '@/types/cad'
import type { Tool, ToolContext, ToolHandlers } from '@/registry/toolRegistry'
import { toolModeHandlers } from '@/tools/toolMode'
import { entityPointXY } from '@/registry/entityRegistry'
import { PIECE_PICK_TOL, pointOnEntity } from '@/utils/geometry/sketchPieces'
import { planSplitEntity, splitKindProblem } from '@/utils/yamlMutations/sketchSplit'

/** What the split tool aims at under the cursor. `refusal` is the sentence the
 *  click would be refused with; a refused preview emits nothing on click. */
export interface SplitPreview {
  featureId: string
  entityId: string
  at: Point
  refusal: string | null
  // A circle's first point waits for a second one before anything is cut.
  needsSecondPoint: boolean
}

/** A circle's first click, held until the second one. */
export interface SplitPending {
  featureId: string
  entityId: string
  at: Point[]
}

type SplitFeature = Pick<SketchFeature, 'id' | 'entities' | 'initial' | 'constraints'>

export interface SplitHoverInput {
  activeFeatureId: string | null
  // The document feature being edited; its `initial` is the solved geometry.
  feature: SplitFeature | null
  // `entity:<sketch>:<id>` under the cursor, if any.
  hoveredSelectionId: string | null
  // The vertex or inferred-contact key under the cursor and where it sits.
  hoveredVertexId: string | null
  snapPoint: Point | null
  // The cursor on the sketch plane, in sketch-local coordinates.
  cursor: Point | null
  // The entity the previous preview aimed at: a snap point is taken on it,
  // since a vertex hover leaves no curve under the cursor.
  previousEntityId: string | null
  pending: SplitPending | null
}

/** Where a hovered vertex or inferred contact sits: a `vertex:` key resolves
 *  against the document feature, an `isect:`/`dock:` handle against the
 *  inferred-contact set the viewport already derived (its position is not in
 *  the document). */
export function splitSnapPoint(
  hoveredVertexId: string | null,
  feature: SplitFeature | null,
  inferred: ReadonlyArray<{ id: string; position: readonly [number, number] }>,
): Point | null {
  if (hoveredVertexId === null) return null
  const contact = inferred.find(c => c.id === hoveredVertexId)
  if (contact !== undefined) return [contact.position[0], contact.position[1]]
  if (feature === null || !hoveredVertexId.startsWith(`vertex:${feature.id}:`)) return null
  const rest = hoveredVertexId.slice(`vertex:${feature.id}:`.length)
  const cut = rest.lastIndexOf(':')
  if (cut <= 0) return null
  const entityId = rest.slice(0, cut)
  const entity = (feature.entities ?? []).find(e => e.id === entityId)
  if (entity === undefined) return null
  return entityPointXY(entity.kind, feature.initial?.[entityId] ?? [], rest.slice(cut + 1)) ?? null
}

function entityIdOf(selectionId: string | null, featureId: string): string | null {
  const prefix = `entity:${featureId}:`
  return selectionId !== null && selectionId.startsWith(prefix) ? selectionId.slice(prefix.length) : null
}

/** Resolve the split preview for the current hover, or null when the cursor
 *  is over nothing the tool can cut. */
export function resolveSplitPreview(input: SplitHoverInput): SplitPreview | null {
  const { activeFeatureId, feature } = input
  if (activeFeatureId === null || feature === null || feature.id !== activeFeatureId) return null
  const entities = feature.entities ?? []
  const hovered = entityIdOf(input.hoveredSelectionId, activeFeatureId)
  const entityId = hovered ?? (input.hoveredVertexId !== null ? input.previousEntityId : null)
  if (entityId === null) return null
  const entity = entities.find(e => e.id === entityId)
  if (entity === undefined) return null
  const params = feature.initial?.[entityId] ?? []

  let at: Point | null = null
  if (input.hoveredVertexId !== null && input.snapPoint !== null) {
    // A snap point owns the click only when it lies on this curve: a vertex of
    // some unrelated entity is not a place to cut this one.
    const foot = pointOnEntity(entity.kind, params, input.snapPoint)
    if (foot !== null && foot.distance <= PIECE_PICK_TOL) at = [input.snapPoint[0], input.snapPoint[1]]
    else if (hovered === null) return null
  }
  if (at === null) {
    if (input.cursor === null) return null
    const foot = pointOnEntity(entity.kind, params, input.cursor)
    at = foot === null ? [input.cursor[0], input.cursor[1]] : foot.foot
  }

  const kindProblem = splitKindProblem(entity.kind)
  if (kindProblem !== null) {
    return { featureId: activeFeatureId, entityId, at, refusal: kindProblem, needsSecondPoint: false }
  }
  const pending = input.pending !== null && input.pending.featureId === activeFeatureId
    && input.pending.entityId === entityId ? input.pending.at : []
  if (entity.kind === 'circle' && pending.length === 0) {
    // The first point cuts nothing yet, but a circle the constraints forbid
    // splitting must say so now, not after the second click: plan it against
    // the opposite point, which only the constraint checks can refuse.
    const [cx, cy] = params
    const probe = planSplitEntity(feature, entityId, [at, [2 * cx - at[0], 2 * cy - at[1]]])
    const refusal = 'reason' in probe ? probe.reason : null
    return { featureId: activeFeatureId, entityId, at, refusal, needsSecondPoint: refusal === null }
  }
  const plan = planSplitEntity(feature, entityId, [...pending, at])
  return {
    featureId: activeFeatureId,
    entityId,
    at,
    refusal: 'reason' in plan ? plan.reason : null,
    needsSecondPoint: false,
  }
}

/** What a click does with the current preview. */
export type SplitClickOutcome =
  | { kind: 'split'; mutation: Extract<Mutation, { type: 'split_entity' }> }
  | { kind: 'pending'; pending: SplitPending }
  | { kind: 'refused'; reason: string }
  | { kind: 'none' }

export function splitClickOutcome(preview: SplitPreview | null, pending: SplitPending | null): SplitClickOutcome {
  if (preview === null) return { kind: 'none' }
  if (preview.refusal !== null) return { kind: 'refused', reason: preview.refusal }
  if (preview.needsSecondPoint) {
    return { kind: 'pending', pending: { featureId: preview.featureId, entityId: preview.entityId, at: [preview.at] } }
  }
  const held = pending !== null && pending.featureId === preview.featureId && pending.entityId === preview.entityId
    ? pending.at : []
  return {
    kind: 'split',
    mutation: {
      type: 'split_entity',
      featureId: preview.featureId,
      entityId: preview.entityId,
      at: [...held, preview.at],
    },
  }
}

export interface SplitToolContext extends ToolContext {
  splitPreview: SplitPreview | null
  splitPending: SplitPending | null
  setSplitPending: (pending: SplitPending | null) => void
}

export interface SplitTool extends Tool {
  readonly category: 'selection'
}

/**
 * Split tool. A click emits one `split_entity` for the hovered preview, holds a
 * circle's first point, or does nothing on a refused preview (the marker shows
 * the reason). The tool stays armed for the next cut.
 */
export function createSplitTool(): SplitTool {
  const handlers: ToolHandlers<SplitToolContext> = {
    onPointerDown: () => null,
    onPointerMove: () => {},
    onPointerUp: () => {},
    onClick: (_e, _worldPt, context) => {
      const outcome = splitClickOutcome(context.splitPreview, context.splitPending)
      if (outcome.kind === 'pending') {
        context.setSplitPending(outcome.pending)
        return
      }
      if (outcome.kind !== 'split') return
      context.setSplitPending(null)
      context.onMutation?.(outcome.mutation)
    },
  }

  return {
    id: 'split',
    label: 'Split',
    category: 'selection' as const,
    ...toolModeHandlers('split'),
    handlers,
  }
}
