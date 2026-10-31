// An armed section pick is its own gesture: it must see the face/plane layers
// even under a drawing tool (whose hover filter excludes them), it must not be
// beaten by an edge a few pixels from the face, and a miss must keep it armed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture, flushHoverFrame } from './idBufferDispatchHarness'
import { EDGE_LAYER_NAME, FACE_LAYER_NAME, PLANE_LAYER_NAME } from '@/picking'
import { useEditorState } from '@/hooks/useEditorState'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import {
  DEFAULT_SECTION_STATE, SECTION_FACE_NOT_FLAT_REASON, SECTION_PICK_MISS_REASON, useSectionStore,
} from '@/stores/sectionStore'

const h = vi.hoisted(() => ({ faceFrame: vi.fn() }))

vi.mock('@/viewport/faceFrameFromSolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/viewport/faceFrameFromSolve')>()),
  faceFrameFromSolve: (...args: unknown[]) => h.faceFrame(...args),
}))

const FACE_HIT = {
  id: 7, layer: FACE_LAYER_NAME, entityKey: '?04;face', pickKey: 'body#face#0', distancePx: 0,
}

const PLANE_HIT = {
  id: 9, layer: PLANE_LAYER_NAME, entityKey: '@Plane1', pickKey: '@Plane1', distancePx: 0,
}

describe('section pick dispatch', () => {
  let canvas: HTMLCanvasElement
  let pipeline: ReturnType<typeof newIdBufferDispatchFixture>['pipeline']
  let glRef: { current: unknown }

  beforeEach(() => {
    ({ canvas, pipeline, glRef } = newIdBufferDispatchFixture())
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true, picking: true })
    useSketchEditorStore.setState({ hoveredSelectionId: null, hoveredPickKey: null, normalSelection: new Set() })
    h.faceFrame.mockReset()
    h.faceFrame.mockReturnValue({ normal: [0, 0, 1], center: [0, 0, 0] })
    pipeline.resolveSync = vi.fn().mockReturnValue(FACE_HIT)
    pipeline.target.markClean()
  })

  afterEach(() => {
    disposeIdBufferDispatchFixture(pipeline)
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  })

  it('resolves against the face and plane layers even while a drawing tool is active', async () => {
    // The line tool's hover preset excludes the face layer; an armed section
    // pick is not a hover, so it must still reach it.
    useEditorState.setState({ activeTool: 'line' })
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME, EDGE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    const resolve = pipeline.resolveSync as unknown as ReturnType<typeof vi.fn>
    expect(resolve).toHaveBeenCalledTimes(1)
    const opts = resolve.mock.calls[0][2] as { allowedLayers: ReadonlySet<string> }
    expect(opts.allowedLayers.has(FACE_LAYER_NAME)).toBe(true)
    expect(opts.allowedLayers.has(PLANE_LAYER_NAME)).toBe(true)
    expect(opts.allowedLayers.has(EDGE_LAYER_NAME)).toBe(false)
    expect(h.faceFrame.mock.calls[0].slice(1)).toEqual(['?04;face', 'body#face#0'])
    expect(useSectionStore.getState().plane).toEqual({ kind: 'query', query: '?04;face', pickKey: 'body#face#0' })
    expect(useSectionStore.getState().picking).toBe(false)
  })

  it('resolves with only face and plane candidates 3 px from a face edge', async () => {
    // The resolver only ranks faces and planes, so the edge that shares the
    // boundary pixel cannot outrank the face. The mock returns the face the
    // real resolver would; what this pins is that the edge is never a candidate.
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME, EDGE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 103, clientY: 100 }))
    })

    const resolve = pipeline.resolveSync as unknown as ReturnType<typeof vi.fn>
    const opts = resolve.mock.calls[0][2] as { allowedLayers: ReadonlySet<string> }
    expect(opts.allowedLayers.has(EDGE_LAYER_NAME)).toBe(false)
    expect(useSectionStore.getState().plane).toMatchObject({ kind: 'query', query: '?04;face' })
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

  it('keeps picking armed with an error when the click misses, leaving selection alone', async () => {
    pipeline.resolveSync = vi.fn().mockReturnValue(null)
    useSketchEditorStore.setState({ normalSelection: new Set(['@keep']) })
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })

    expect(useSectionStore.getState().plane).toEqual({ kind: 'builtin', id: 'front' })
    expect(useSectionStore.getState().pickError).toBe(SECTION_PICK_MISS_REASON)
    expect(useSectionStore.getState().picking).toBe(true)
    expect(useSketchEditorStore.getState().normalSelection.has('@keep')).toBe(true)
  })

  it('a second empty click disarms and clears the error', async () => {
    pipeline.resolveSync = vi.fn().mockReturnValue(null)
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })
    expect(useSectionStore.getState().pickError).toBe(SECTION_PICK_MISS_REASON)

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 120, clientY: 100 }))
    })
    expect(useSectionStore.getState().picking).toBe(false)
    expect(useSectionStore.getState().pickError).toBeNull()
  })

  it('Escape cancels the armed pick and clears the error', async () => {
    pipeline.resolveSync = vi.fn().mockReturnValue(null)
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })
    expect(useSectionStore.getState().pickError).toBe(SECTION_PICK_MISS_REASON)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useSectionStore.getState().picking).toBe(false)
    expect(useSectionStore.getState().pickError).toBeNull()
  })

  it('filters hover to faces and planes while the pick is armed', async () => {
    pipeline.resolveAsync = vi.fn().mockResolvedValue(PLANE_HIT)
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([FACE_LAYER_NAME, EDGE_LAYER_NAME, PLANE_LAYER_NAME]),
    }))

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
      await Promise.resolve()
    })
    await flushHoverFrame()

    const resolve = pipeline.resolveAsync as unknown as ReturnType<typeof vi.fn>
    const opts = resolve.mock.calls[0][2] as { allowedLayers: ReadonlySet<string> }
    expect([...opts.allowedLayers].sort()).toEqual([FACE_LAYER_NAME, PLANE_LAYER_NAME].sort())
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@Plane1')
  })
})
