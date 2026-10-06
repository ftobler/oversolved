// Shared setup for the split sketch editor store suites. Every suite needs the
// same two steps before each test: a fresh non-throwing tool registry, and a
// store reset that also drops the callback registry so a prior test's handler
// cannot leak into the next one.
import { beforeEach } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'
import { toolRegistry } from '@/registry/toolRegistry'

export function resetSketchEditorStore(): void {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    hoveredSelectionId: null,
    hoveredPickKey: null,
    isPointerDown: false,
    drag: null,
    activeTool: null,
    activeFeatureId: null,
    dimensionPicks: [],
    pendingBrepProjectionIds: [],
    pendingDialog: null,
    activePickField: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    hoveredConstraintEntityIds: new Set(),
    modeStack: [],
    entityKindMap: {},
  })
  setSketchCallback('onMutation', null)
  setSketchCallback('onMutationBatch', null)
  setSketchCallback('beginBrepProjection', null)
  setSketchCallback('cancelBrepProjection', null)
}

// Register the per-test setup. Call inside a suite's describe body so the hooks
// attach to that suite and run in the same order the original file used:
// initialize the registry, then reset the store.
export function installSketchStoreSetup(): void {
  beforeEach(() => {
    toolRegistry.reset()
    initializeTools()
    resetSketchEditorStore()
  })
}
