import { describe, it, expect, vi, afterEach } from 'vitest'
import { subscribeSceneInvalidation } from '@/components/Viewport/sceneInvalidation'
import { editorState } from '@/stores/editorState'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

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
    useViewOptionsStore.getState().setBrightness(1.4)

    expect(invalidate).toHaveBeenCalledTimes(3)

    usePartEditorStore.setState({ isRebuilding: false })
    editorState.getState().setHoveredSelectionId(null)
    useViewOptionsStore.getState().setBrightness(1)
  })

  it('requests a frame for a viewer option that only changes a material', () => {
    // The on-demand canvas never redraws by itself, and a zebra toggle changes
    // no React instance prop on the scene tree, so the store has to be the
    // heartbeat or the user sees the change on the next camera move.
    const invalidate = vi.fn()
    unsubscribe = subscribeSceneInvalidation(invalidate)
    useViewOptionsStore.getState().setZebra(true)
    expect(invalidate).toHaveBeenCalled()
    useViewOptionsStore.getState().setZebra(false)
  })

  it('requests a frame for every section change', () => {
    // Enabling and moving the section change only material uniforms and the
    // shared plane; no React instance prop moves.
    const invalidate = vi.fn()
    unsubscribe = subscribeSceneInvalidation(invalidate)
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })

    useSectionStore.getState().setEnabled(true)
    useSectionStore.getState().setOffset(3)
    useSectionStore.getState().toggleFlipped()
    useSectionStore.getState().setEnabled(false)

    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(4)
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
