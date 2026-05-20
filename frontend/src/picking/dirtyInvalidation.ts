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
 *
 * NOTE: This subscription used to call `pipeline.markDirty()` immediately
 * on store change, but that fired BEFORE React had re-rendered Viewport
 * and Body3D had re-registered its geometry in the ID layers. The
 * Body3D registration hooks (`useFaceIdRegistration`, etc.) already call
 * `pipeline.markDirty()` in their setup and cleanup effects, which ensures
 * the pipeline only re-renders after the new geometry is actually in the
 * layers. The subscription is kept as a no-op observer for future use.
 */
export function subscribePipelineToPartEditor(_pipeline: IdPipeline): () => void {
  let prev = selectScenePartEditorSlice(usePartEditorStore.getState())
  return usePartEditorStore.subscribe((state) => {
    const next = selectScenePartEditorSlice(state)
    if (sceneSliceChanged(prev, next)) {
      prev = next
      // Intentionally NOT marking dirty here.
      // markDirty is handled by the individual Body3D registration effects
      // (useFaceIdRegistration, useEdgeIdRegistration, useVertexIdRegistration)
      // which run after React has committed the new geometry. Marking dirty
      // here would fire before Body3D re-renders, creating a window where
      // the pipeline renders with stale layer data.
    }
  })
}
