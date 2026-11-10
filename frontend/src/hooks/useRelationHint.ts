// React binding for the part editor's relation hints.
//
// The hint is derived from the selection and the live solve, never stored. This
// hook is the ONE builder the part tree and every viewport consumer call, so a
// row and a body cannot disagree about what the selection relates to. A module
// cache keyed on the three input references returns the same `RelationHints`
// object to every consumer, which keeps per-body memo dependencies stable.

import { useMemo } from 'react'
import type { BodyResult, PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { buildPartRelationCtx, PART_RULES } from '@/registry/relationRuleRegistry'
import { hintDrivers, relatedHints, type RelationHints } from '@/picking/relationHint'

interface PartHintMemo {
  selection: ReadonlySet<string>
  ctx: ReturnType<typeof buildPartRelationCtx>
  hints: RelationHints
}

interface PartCtxMemo {
  features: readonly PartFeature[]
  bodies: Readonly<Record<string, BodyResult>>
  rollbackPosition: number | null
  ctx: ReturnType<typeof buildPartRelationCtx>
}

let hintsMemo: PartHintMemo | null = null
let ctxMemo: PartCtxMemo | null = null

/**
 * The editor context, cached on the two solve/document references. A selection
 * click changes neither, so it reuses the creator index and the consumed-sketch
 * maps instead of rebuilding them over every body and feature.
 */
function partCtxFor(
  features: readonly PartFeature[],
  bodies: Readonly<Record<string, BodyResult>>,
  rollbackPosition: number | null,
) {
  if (
    ctxMemo !== null &&
    ctxMemo.features === features &&
    ctxMemo.bodies === bodies &&
    ctxMemo.rollbackPosition === rollbackPosition
  ) return ctxMemo.ctx

  const activeCount = rollbackPosition ?? features.length
  const activeFeatureIds = new Set(features.slice(0, activeCount).map(f => f.id))
  const ctx = buildPartRelationCtx(features, bodies, activeFeatureIds)
  ctxMemo = { features, bodies, rollbackPosition, ctx }
  return ctx
}

/**
 * Pure derivation with a one-entry cache. The inputs are the store's own
 * references, so a re-render that changes none of them is a cache hit and every
 * viewport body keeps the identical hinted set. `rollbackPosition` is an input
 * because a consumer the bar has rolled back past hints nothing.
 */
export function partRelationHintsFor(
  selection: ReadonlySet<string>,
  features: readonly PartFeature[],
  bodies: Readonly<Record<string, BodyResult>>,
  rollbackPosition: number | null,
): RelationHints {
  const ctx = partCtxFor(features, bodies, rollbackPosition)
  if (hintsMemo !== null && hintsMemo.selection === selection && hintsMemo.ctx === ctx) {
    return hintsMemo.hints
  }
  const hints = relatedHints(hintDrivers(selection), PART_RULES, ctx)
  hintsMemo = { selection, ctx, hints }
  return hints
}

/** The current part editor's relation hints, rebuilt only when the selection or
 *  the solve changes. Hover is not an input: hovering drives no hint. */
export function usePartRelationHints(): RelationHints {
  const selection = useSketchEditorStore(s => s.normalSelection)
  const features = usePartEditorStore(s => s.features)
  const bodies = usePartEditorStore(s => s.bodies)
  const rollbackPosition = useEditorState(s => s.rollbackPosition)
  return useMemo(
    () => partRelationHintsFor(selection, features, bodies, rollbackPosition),
    [selection, features, bodies, rollbackPosition],
  )
}

/** The viewport half only: the feature/sketch ids the bodies and sketch lines
 *  read. Shared reference with the tree's computation. */
export function useHintedFeatureIds(): ReadonlySet<string> {
  return usePartRelationHints().viewport
}
