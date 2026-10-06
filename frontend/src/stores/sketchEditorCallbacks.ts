// Callbacks dispatched from pure-layer store actions back into React state.
// Registered by Part.tsx on mount via setSketchCallback(); torn down on unmount.
// Stored outside Zustand so function references don't pollute serializable snapshots.
// Invariant: onMutation/onRebuild/onExitSketch must be non-null while a sketch
// editing session is active; the remaining slots are optional hooks.
//
// This registry lives in its own module so the callback teardown contract has a
// single owner: the store imports it, and helpers import it, but there is still
// exactly one module-level instance for the app lifetime. It was the private
// `_sketchCbs` const before the store was split; the contract is unchanged.
import type { Mutation, Sketch } from '@/types/cad'
import type { DimensionPick } from '@/registry'
import { devOnly } from './stateInvariants'

export const sketchCallbacks: {
  onMutation: ((m: Mutation) => void) | null
  onMutationBatch: ((ms: Mutation[]) => void) | null
  onRebuild: (() => void) | null
  onExitSketch: (() => void) | null
  getSketch: ((featureId: string) => Sketch | null) | null
  beginBrepProjection: (() => void) | null
  cancelBrepProjection: (() => void) | null
} = {
  onMutation: null,
  onMutationBatch: null,
  onRebuild: null,
  onExitSketch: null,
  getSketch: null,
  beginBrepProjection: null,
  cancelBrepProjection: null,
}

export function setSketchCallback(key: 'onMutation', cb: ((m: Mutation) => void) | null): void
export function setSketchCallback(key: 'onMutationBatch', cb: ((ms: Mutation[]) => void) | null): void
export function setSketchCallback(key: 'onRebuild' | 'onExitSketch', cb: (() => void) | null): void
export function setSketchCallback(key: 'getSketch', cb: ((featureId: string) => Sketch | null) | null): void
export function setSketchCallback(key: 'beginBrepProjection' | 'cancelBrepProjection', cb: (() => void) | null): void
export function setSketchCallback(key: keyof typeof sketchCallbacks, cb: unknown): void {
  (sketchCallbacks as Record<string, unknown>)[key] = cb
}

export function getSketchCallback<K extends keyof typeof sketchCallbacks>(key: K): (typeof sketchCallbacks)[K] {
  return sketchCallbacks[key]
}

export function requireMutation(name: string): ((m: Mutation) => void) | null {
  const onMutation = sketchCallbacks.onMutation
  if (!onMutation) {
    if (devOnly) console.warn(`[sketchEditorStore] onMutation: callback not registered -- ${name} will be a no-op.`)
  }
  return onMutation
}

// Deletes the given sketch entities with no undo entry. Used when a dimension
// gesture is aborted or a pick replaced: the projection was scratch work, so
// neither it nor the delete that removes it may appear in the history. The
// delete rides the brep withhold so it applies without pushing. No trailing
// cancelBrepProjection here: the replace path needs the withhold's captured doc
// to survive for the gesture's eventual commit, and the abort path nulls it
// explicitly after this returns.
export function dispatchWithheldDelete(targets: string[]): void {
  const onMutation = sketchCallbacks.onMutation
  if (!onMutation || targets.length === 0) return
  sketchCallbacks.beginBrepProjection?.()
  onMutation({ type: 'delete', targets })
}

// Entity id of the projection a brep pick targets, from its wire target
// ('entity:<fid>:<eid>' or 'vertex:<fid>:<eid>:xy'). Only a brep pick carries
// the source query, which is what distinguishes it from a plain sketch pick.
export function pickProjectionEntityId(pick: DimensionPick, featureId: string): string | null {
  if (!pick.source) return null
  const parts = pick.target.split(':')
  if (parts[1] !== featureId) return null
  if (parts[0] !== 'entity' && parts[0] !== 'vertex') return null
  return parts[2] ?? null
}
