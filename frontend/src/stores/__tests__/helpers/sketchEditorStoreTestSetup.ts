// Shared setup for the split sketch editor store suites. Every suite needs the
// same two steps before each test: a fresh non-throwing tool registry, and a
// store reset that also drops the callback registry so a prior test's handler
// cannot leak into the next one.
import { beforeEach } from 'vitest'
import { clearSketchCallbacks, useSketchUiStore } from '@/stores/sketchEditorStore'
import { initializeTools } from '@/tools'
import { toolRegistry } from '@/registry/toolRegistry'
import { useEditorState } from '@/hooks/useEditorState'

// The two stores own their resets and the callback registry owns its teardown;
// listing fields here is how this helper once fell behind the store.
export function resetSketchEditorStore(): void {
  useEditorState.getState().resetTransientState()
  useSketchUiStore.getState().resetTransientState()
  clearSketchCallbacks()
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
