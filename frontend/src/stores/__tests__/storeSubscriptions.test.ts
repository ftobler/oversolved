/**
 * Asserts that the per-entity hook and Zustand store state follow the
 * low-overhead subscription patterns introduced in fix-frontend-store-subscriptions.
 */
import { describe, it, expect } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
// ── test_no_functions_in_store ────

describe('test_no_functions_in_store', () => {
  it('sketchEditorStore state does not contain onMutation, onRebuild, or onExitSketch', () => {
    const state = useSketchEditorStore.getState() as unknown as Record<string, unknown>
    expect('onMutation' in state).toBe(false)
    expect('onRebuild' in state).toBe(false)
    expect('onExitSketch' in state).toBe(false)
  })
})
