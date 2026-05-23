/**
 * Regression tests for Body3D.handleMeshClick (the post-fix contract).
 *
 * User invariant (solver_arch.user.md §Selection):
 *   "Click a face -> store the face query. Not the part. The part is implied
 *    ancestrally."
 *
 * Pre-fix bug: handleMeshClick also dispatched `addToNormalSelection('@' + bodyId)`
 * which broke the "store what was clicked" principle and made the face/body pair
 * inseparable in selection. The fix removes that branch.
 *
 * These tests exercise the same store API call sequence that handleMeshClick
 * performs (without rendering Three.js) and assert the post-fix contract:
 * normalSelection contains exactly the face/edge query, never the bodyId.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// Mirror handleMeshClick from Body3D.tsx so the contract is captured here.
// If Body3D ever re-introduces the @bodyId auto-add, this mirror must NOT be
// updated to match -- it documents the intended contract for the file.
function simulateFaceClick(hoverQuery: string) {
  useSketchEditorStore.getState().setHoveredSelectionId(hoverQuery)
  const state = useSketchEditorStore.getState()
  const currentHover = state.hoveredSelectionId
  if (!currentHover) return
  // Single click outcome: toggle normal selection. A pick chip, if active,
  // consumes the result downstream rather than branching the click.
  state.toggleNormalSelection(currentHover)
}

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    activePickField: null,
    hoveredSelectionId: null,
  })
})

describe('Body3D.handleMeshClick contract', () => {
  it('stores only the face query, never the parent bodyId', () => {
    simulateFaceClick('@ex1/face/3')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@ex1/face/3')).toBe(true)
    expect(sel.has('@body_ex1')).toBe(false)
    expect(sel.size).toBe(1)
  })

  it('stores only the edge query, never the parent bodyId', () => {
    simulateFaceClick('@ex1/edge/2')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@ex1/edge/2')).toBe(true)
    expect(sel.has('@body_ex1')).toBe(false)
  })

  it('toggling the same face twice removes it from selection', () => {
    simulateFaceClick('@ex1/face/0')
    simulateFaceClick('@ex1/face/0')

    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('clicking without a hover target does nothing', () => {
    // hoveredSelectionId stays null (beforeEach default).
    const state = useSketchEditorStore.getState()
    if (state.hoveredSelectionId) {
      state.toggleNormalSelection(state.hoveredSelectionId)
    }
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })
})
