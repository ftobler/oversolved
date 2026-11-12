// React binding for the part editor's relation hints.
//
// The hint is derived from the selection and the live solve, never stored. This
// hook is the ONE builder the part tree and every viewport consumer call, so a
// row and a body cannot disagree about what the selection relates to. A module
// cache keyed on the input references returns the same `RelationHints` object to
// every consumer, which keeps per-body memo dependencies stable.

import { useMemo } from 'react'
import type { BodyResult, PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { buildPartRelationCtx, PART_RULES } from '@/registry/relationRuleRegistry'
import { failedPickQueries } from '@/picking/pickFailures'
import {
  EMPTY_RELATION_SET,
  hintDrivers,
  relatedHints,
  type RelationHints,
} from '@/picking/relationHint'

interface PartHintMemo {
  selection: ReadonlySet<string>
  focus: string | null
  ctx: ReturnType<typeof buildPartRelationCtx>
  hints: RelationHints
}

interface PartCtxMemo {
  features: readonly PartFeature[]
  bodies: Readonly<Record<string, BodyResult>>
  rollbackPosition: number | null
  failedPicks: ReadonlySet<string>
  ctx: ReturnType<typeof buildPartRelationCtx>
}

let hintsMemo: PartHintMemo | null = null
let ctxMemo: PartCtxMemo | null = null

/**
 * The editor context, cached on the solve/document references. A selection
 * click changes none of them, so it reuses the creator index, the published-
 * query set and the consumed-sketch maps instead of rebuilding them over every
 * body and feature.
 */
function partCtxFor(
  features: readonly PartFeature[],
  bodies: Readonly<Record<string, BodyResult>>,
  rollbackPosition: number | null,
  failedPicks: ReadonlySet<string>,
) {
  if (
    ctxMemo !== null &&
    ctxMemo.features === features &&
    ctxMemo.bodies === bodies &&
    ctxMemo.rollbackPosition === rollbackPosition &&
    ctxMemo.failedPicks === failedPicks
  ) return ctxMemo.ctx

  const activeCount = rollbackPosition ?? features.length
  const activeFeatureIds = new Set(features.slice(0, activeCount).map(f => f.id))
  const ctx = buildPartRelationCtx(features, bodies, activeFeatureIds, failedPicks)
  ctxMemo = { features, bodies, rollbackPosition, failedPicks, ctx }
  return ctx
}

/**
 * Pure derivation with a one-entry cache. The inputs are the store's own
 * references, so a re-render that changes none of them is a cache hit and every
 * viewport body keeps the identical hinted set. `rollbackPosition` is an input
 * because a consumer the bar has rolled back past hints nothing.
 *
 * `editingFeatureId` is the feature the open editor is acting on. Entering an
 * edit does not select its row (a double-click toggles the row on and off), so
 * without it the editor would show none of its own picks. It runs only the
 * pick-paint rules: the editor shows what the feature picked, not every face it
 * created.
 */
export function partRelationHintsFor(
  selection: ReadonlySet<string>,
  features: readonly PartFeature[],
  bodies: Readonly<Record<string, BodyResult>>,
  rollbackPosition: number | null,
  editingFeatureId: string | null = null,
  failedPicks: ReadonlySet<string> = EMPTY_RELATION_SET,
): RelationHints {
  const ctx = partCtxFor(features, bodies, rollbackPosition, failedPicks)
  if (
    hintsMemo !== null &&
    hintsMemo.selection === selection &&
    hintsMemo.focus === editingFeatureId &&
    hintsMemo.ctx === ctx
  ) {
    return hintsMemo.hints
  }
  const focus = editingFeatureId === null ? [] : [`@${editingFeatureId}`]
  const hints = relatedHints(hintDrivers(selection), PART_RULES, ctx, focus)
  hintsMemo = { selection, focus: editingFeatureId, ctx, hints }
  return hints
}

/** The current part editor's relation hints, rebuilt only when the selection,
 *  the open editor or the solve changes. Hover is not an input: hovering drives
 *  no hint. */
export function usePartRelationHints(): RelationHints {
  const selection = useSketchEditorStore(s => s.normalSelection)
  const features = usePartEditorStore(s => s.features)
  const bodies = usePartEditorStore(s => s.bodies)
  const solveResults = usePartEditorStore(s => s.solveResults)
  const rollbackPosition = useEditorState(s => s.rollbackPosition)
  const editingFeatureId = useEditorState(s => s.editingFeatureId)
  const failedPicks = useMemo(() => failedPickQueries(solveResults), [solveResults])
  return useMemo(
    () => partRelationHintsFor(selection, features, bodies, rollbackPosition, editingFeatureId, failedPicks),
    [selection, features, bodies, rollbackPosition, editingFeatureId, failedPicks],
  )
}

/** The creator half only: the feature/sketch ids the bodies and sketch lines
 *  read. Shared reference with the tree's computation. */
export function useHintedFeatureIds(): ReadonlySet<string> {
  return usePartRelationHints().viewport
}
