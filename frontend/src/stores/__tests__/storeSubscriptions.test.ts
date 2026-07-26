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

// Every pointer move tears the previous hover down before applying the new one,
// and the teardown runs once per registered body. A setter that writes
// unconditionally turns each of those into a store notification delivered to every
// subscriber in the scene, which is quadratic in the size of the model. The hover
// setters must therefore leave the state object untouched when nothing changed --
// zustand skips the notification entirely in that case.
describe('hover setters do not notify when nothing changed', () => {
  function countNotifications(run: () => void): number {
    let notifications = 0
    const unsubscribe = useSketchEditorStore.subscribe(() => { notifications++ })
    try { run() } finally { unsubscribe() }
    return notifications
  }

  it('setHoveredFaceGeometry is silent on a repeated clear', () => {
    const s = useSketchEditorStore.getState()
    s.setHoveredFaceGeometry(null, null)
    expect(countNotifications(() => {
      for (let i = 0; i < 50; i++) s.setHoveredFaceGeometry(null, null)
    })).toBe(0)
  })

  it('setHoveredFaceGeometry is silent when the same coordinates are re-sent', () => {
    const s = useSketchEditorStore.getState()
    s.setHoveredFaceGeometry([0, 0, 1], [1, 2, 3])
    // A freshly built tuple holding the same numbers is the same hover.
    expect(countNotifications(() => s.setHoveredFaceGeometry([0, 0, 1], [1, 2, 3]))).toBe(0)
    expect(countNotifications(() => s.setHoveredFaceGeometry([0, 1, 0], [1, 2, 3]))).toBe(1)
    s.setHoveredFaceGeometry(null, null)
  })

  it('setHoveredVertex is silent on a repeated clear and fires on a real change', () => {
    const s = useSketchEditorStore.getState()
    s.setHoveredVertex(null, null, null)
    expect(countNotifications(() => {
      for (let i = 0; i < 50; i++) s.setHoveredVertex(null, null, null)
    })).toBe(0)
    expect(countNotifications(() => s.setHoveredVertex('v1', [3, 4], null))).toBe(1)
    expect(countNotifications(() => s.setHoveredVertex('v1', [3, 4], null))).toBe(0)
    s.setHoveredVertex(null, null, null)
  })
})
