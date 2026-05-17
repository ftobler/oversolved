import { usePartEditorStore, type PartEditorData } from '@/stores/partEditorStore'
import type { IdPipeline } from './IdPipeline'

/**
 * Slice of `partEditorStore` that influences what the ID buffer renders.
 * Selection, hover, ghostMode, undo stacks, and panel state are
 * intentionally NOT in this slice — they don't change pixels.
 */
export interface ScenePartEditorSlice {
  bodies: PartEditorData['bodies']
  pickBodies: PartEditorData['pickBodies']
  visibleBodies: PartEditorData['visibleBodies']
  visibleFeatures: PartEditorData['visibleFeatures']
  rollbackPosition: PartEditorData['rollbackPosition']
  otherSketches: PartEditorData['otherSketches']
}

export function selectScenePartEditorSlice(s: PartEditorData): ScenePartEditorSlice {
  return {
    bodies: s.bodies,
    pickBodies: s.pickBodies,
    visibleBodies: s.visibleBodies,
    visibleFeatures: s.visibleFeatures,
    rollbackPosition: s.rollbackPosition,
    otherSketches: s.otherSketches,
  }
}

export function sceneSliceChanged(prev: ScenePartEditorSlice, next: ScenePartEditorSlice): boolean {
  return (
    next.bodies !== prev.bodies ||
    next.pickBodies !== prev.pickBodies ||
    next.visibleBodies !== prev.visibleBodies ||
    next.visibleFeatures !== prev.visibleFeatures ||
    next.rollbackPosition !== prev.rollbackPosition ||
    next.otherSketches !== prev.otherSketches
  )
}

/**
 * Subscribe `pipeline.markDirty` to the scene-shape slice of
 * `partEditorStore`. Returns the unsubscribe function.
 */
export function subscribePipelineToPartEditor(pipeline: IdPipeline): () => void {
  let prev = selectScenePartEditorSlice(usePartEditorStore.getState())
  return usePartEditorStore.subscribe((state) => {
    const next = selectScenePartEditorSlice(state)
    if (sceneSliceChanged(prev, next)) {
      prev = next
      pipeline.markDirty('partEditorStore')
    }
  })
}
