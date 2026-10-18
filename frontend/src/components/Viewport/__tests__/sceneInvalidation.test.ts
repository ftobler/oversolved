import { describe, it, expect, vi, afterEach } from 'vitest'
import { subscribeSceneInvalidation } from '@/components/Viewport/sceneInvalidation'
import { editorState } from '@/stores/editorState'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchUiStore } from '@/stores/sketchEditorStore'

// The part viewport draws on demand, so a store write that reaches the scene
// has to ask for a frame. These cases pin the "which stores" half of that
// policy against the real stores; the wiring into R3F is pinned in
// Viewport.demandFrameloop.test.tsx.

describe('subscribeSceneInvalidation', () => {
  let unsubscribe: (() => void) | null = null

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  it('requests a frame on a change in each store that feeds the scene', () => {
    const invalidate = vi.fn()
    unsubscribe = subscribeSceneInvalidation(invalidate)

    usePartEditorStore.setState({ isRebuilding: true })
    editorState.getState().setHoveredSelectionId('@ex1')
    useSketchUiStore.setState({ showDebugHit: true })

    expect(invalidate).toHaveBeenCalledTimes(3)

    usePartEditorStore.setState({ isRebuilding: false })
    editorState.getState().setHoveredSelectionId(null)
    useSketchUiStore.setState({ showDebugHit: false })
  })

  it('stops requesting frames once unsubscribed', () => {
    // The Viewport tears the subscription down on unmount; a leaked one would
    // call invalidate on a disposed root.
    const invalidate = vi.fn()
    const stop = subscribeSceneInvalidation(invalidate)
    stop()

    usePartEditorStore.setState({ isRebuilding: true })
    editorState.getState().setHoveredSelectionId('@ex1')

    expect(invalidate).not.toHaveBeenCalled()

    usePartEditorStore.setState({ isRebuilding: false })
    editorState.getState().setHoveredSelectionId(null)
  })
})
