import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch, wasLastClickConsumedByIdDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks } from '../dimensionLabelCallbacks'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture } from './idBufferDispatchHarness'

describe('useIdBufferPointerDispatch', () => {
  let canvas: HTMLCanvasElement
  let pipeline: IdPipeline
  let glRef: { current: unknown }
  beforeEach(() => {
    ({ canvas, pipeline, glRef } = newIdBufferDispatchFixture())
  })
  afterEach(() => {
    disposeIdBufferDispatchFixture(pipeline)
  })

  // L28: the click router must honor the dimensionLabelAdapter's verdict.
  // In the mount window between ID registration and registerDimCallbacks
  // nothing is registered for a label, so the adapter returns false and the
  // click has to fall through unconsumed (empty-space semantics: the backplane
  // / onPointerMissed may clear) instead of being swallowed unheard.
  describe('swallow-only click routing honors the adapter verdict', () => {
    function stubHit(layer: string, entityKey: string) {
      pipeline.resolveSync = vi.fn().mockReturnValue({ id: 1, layer, entityKey, distancePx: 0 })
    }

    it('an unhandled dimension-label click falls through unconsumed', async () => {
      stubHit(DIMENSION_LABEL_LAYER_NAME, 'dim:ghost')
      useSketchEditorStore.setState({ activeTool: null, normalSelection: new Set(['sk1/keep']) })

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(wasLastClickConsumedByIdDispatch()).toBe(false)
      // The dim key never leaks into normalSelection either way.
      expect(useSketchEditorStore.getState().normalSelection.has('dim:ghost')).toBe(false)
    })

    it('a handled dimension-label click is still consumed', async () => {
      const onClick = vi.fn()
      registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick, onDoubleClick: () => {}, onPointerDown: () => {} })
      stubHit(DIMENSION_LABEL_LAYER_NAME, 'dim:c1')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(onClick).toHaveBeenCalledTimes(1)
      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
    })

    it('a feature-handle click stays consumed with no adapter verdict to honor', async () => {
      stubHit(FEATURE_HANDLE_LAYER_NAME, 'fhandle:extrude1')
      useSketchEditorStore.setState({ activeTool: null, normalSelection: new Set() })

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([FEATURE_HANDLE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(wasLastClickConsumedByIdDispatch()).toBe(true)
      expect(useSketchEditorStore.getState().normalSelection.has('fhandle:extrude1')).toBe(false)
    })
  })
})
