// An armed section pick is its own gesture: it must see the face/plane layers
// even under a drawing tool (whose hover filter excludes them), and a curved
// face must be refused with a truthful reason instead of stored as a source
// that later auto-disables.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture } from './idBufferDispatchHarness'
import { FACE_LAYER_NAME } from '@/picking'
import { useEditorState } from '@/hooks/useEditorState'
import { DEFAULT_SECTION_STATE, SECTION_FACE_NOT_FLAT_REASON, useSectionStore } from '@/stores/sectionStore'

const h = vi.hoisted(() => ({ faceFrame: vi.fn() }))

vi.mock('../bodyDispatchCallbacks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bodyDispatchCallbacks')>()),
  findFaceFrame: (...args: unknown[]) => h.faceFrame(...args),
}))

const FACE_HIT = {
  id: 7, layer: FACE_LAYER_NAME, entityKey: '?04;face', pickKey: 'body#face#0', distancePx: 0,
}

describe('section pick dispatch', () => {
  let canvas: HTMLCanvasElement
  let pipeline: ReturnType<typeof newIdBufferDispatchFixture>['pipeline']
  let glRef: { current: unknown }

  beforeEach(() => {
    ({ canvas, pipeline, glRef } = newIdBufferDispatchFixture())
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true, picking: true })
    h.faceFrame.mockReset()
    h.faceFrame.mockReturnValue({ normal: [0, 0, 1], center: [0, 0, 0] })
    pipeline.resolveSync = vi.fn().mockReturnValue(FACE_HIT)
  })

  afterEach(() => {
    disposeIdBufferDispatchFixture(pipeline)
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  })

  it('resolves against the consumed layers even while a drawing tool is active', async () => {
    // The line tool's hover preset excludes the face layer; an armed section
    // pick is not a hover, so it must still reach it.
    useEditorState.setState({ activeTool: 'line' })
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    const resolve = pipeline.resolveSync as unknown as ReturnType<typeof vi.fn>
    expect(resolve).toHaveBeenCalledTimes(1)
    const opts = resolve.mock.calls[0][2] as { allowedLayers: ReadonlySet<string> }
    expect(opts.allowedLayers.has(FACE_LAYER_NAME)).toBe(true)
    expect(useSectionStore.getState().plane).toEqual({ kind: 'query', query: '?04;face' })
    expect(useSectionStore.getState().picking).toBe(false)
  })

  it('refuses a curved face and says why, keeping the current section', async () => {
    h.faceFrame.mockReturnValue(null)
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(useSectionStore.getState().plane).toEqual({ kind: 'builtin', id: 'front' })
    expect(useSectionStore.getState().pickError).toBe(SECTION_FACE_NOT_FLAT_REASON)
    // Still armed, so the user can click another face without reopening the card.
    expect(useSectionStore.getState().picking).toBe(true)
  })
})
