import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks } from '../dimensionLabelCallbacks'
import { DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME } from '@/picking'
import { registerDimensionLabelElement, resetDimensionLabelDomBoxesForTest } from '@/picking/dimensionLabelDom'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture } from './idBufferDispatchHarness'

/**
 * A dimension label's click target is the rendered text, not a point. Before
 * the DOM box, only the ring at the label's centre was pickable inside the
 * default 8 px pick reach, so the outer glyphs of any label wider than ~16 px
 * fell through to the geometry behind them (or to a viewport miss that cleared
 * the selection), and hover never reached the text. These tests put the pointer
 * 75 px from the label centre, well beyond any pick window, and expect the
 * label's own handlers to run.
 */

function labelElement(left = 100, top = 50, width = 80, height = 17): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({
    left, top, right: left + width, bottom: top + height,
    width, height, x: left, y: top, toJSON: () => ({}),
  }) as DOMRect
  return el
}

describe('useIdBufferPointerDispatch dimension label DOM box', () => {
  let canvas: HTMLCanvasElement
  let pipeline: ReturnType<typeof newIdBufferDispatchFixture>['pipeline']
  let glRef: { current: unknown }

  beforeEach(() => {
    ({ canvas, pipeline, glRef } = newIdBufferDispatchFixture())
    registerDimensionLabelElement('c1', labelElement())
  })
  afterEach(() => {
    resetDimensionLabelDomBoxesForTest()
    disposeIdBufferDispatchFixture(pipeline)
  })

  function mount() {
    return renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME]),
    }))
  }

  it('a click on the far glyphs dispatches the label click, not the geometry behind it', async () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', {
      onOver: () => {}, onOut: () => {}, onClick,
      onDoubleClick: () => {}, onPointerDown: () => {},
    })
    // The geometry under that pixel, which an 8 px ring would have resolved.
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: FACE_LAYER_NAME, entityKey: '@b/face/0', distancePx: 0,
    })

    mount()
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 175, clientY: 60 }))
    })

    expect(onClick).toHaveBeenCalledWith(175, 60)
    expect(pipeline.resolveSync).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.has('@b/face/0')).toBe(false)
  })

  it('hover reaches the far glyphs without a GPU readback', async () => {
    const onOver = vi.fn()
    registerDimCallbacks('c1', {
      onOver, onOut: () => {}, onClick: () => {},
      onDoubleClick: () => {}, onPointerDown: () => {},
    })
    pipeline.resolveAsync = vi.fn().mockResolvedValue(null)

    mount()
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 175, clientY: 60 }))
    })

    expect(onOver).toHaveBeenCalledTimes(1)
    expect(pipeline.resolveAsync).not.toHaveBeenCalled()
  })

  it('a click outside the glyphs keeps the normal ID-buffer resolve', async () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', {
      onOver: () => {}, onOut: () => {}, onClick,
      onDoubleClick: () => {}, onPointerDown: () => {},
    })
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: FACE_LAYER_NAME, entityKey: '@b/face/0', distancePx: 0,
    })

    mount()
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 10, clientY: 10 }))
    })

    expect(onClick).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.has('@b/face/0')).toBe(true)
  })

  it('leaving the glyphs returns hover to the ID-buffer resolve', async () => {
    const onOver = vi.fn()
    registerDimCallbacks('c1', {
      onOver, onOut: () => {}, onClick: () => {},
      onDoubleClick: () => {}, onPointerDown: () => {},
    })
    pipeline.resolveAsync = vi.fn().mockResolvedValue(null)

    mount()
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 175, clientY: 60 }))
    })
    expect(pipeline.resolveAsync).not.toHaveBeenCalled()

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10 }))
    })
    expect(pipeline.resolveAsync).toHaveBeenCalled()
  })
})
