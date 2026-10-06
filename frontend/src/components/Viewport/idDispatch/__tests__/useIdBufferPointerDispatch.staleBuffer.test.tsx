import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { registerDimCallbacks } from '../dimensionLabelCallbacks'
import { IdPipeline, DIMENSION_LABEL_LAYER_NAME, EDGE_LAYER_NAME } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { newIdBufferDispatchFixture, disposeIdBufferDispatchFixture, flushHoverFrame } from './idBufferDispatchHarness'

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

  // A stale-buffer miss (resolveSync null while the pipeline is dirty) is a
  // transient transition, not empty space: it must not finalise a dimension
  // placement, exactly as shouldClearSelectionOnBackplaneClick refuses to
  // clear selection on the same click.
  describe('dimension finalize vs stale buffer', () => {
    const PICK = { isVertex: false, target: 'entity:feat1:l1' }

    function setupDimensionGesture() {
      useSketchEditorStore.setState({
        activeTool: 'dimension',
        activeFeatureId: 'feat1',
        dimensionPicks: [PICK],
      })
      pipeline.resolveSync = vi.fn().mockReturnValue(null)
      return vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')
    }

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('does not finalise when the miss came from a stale (dirty) buffer', async () => {
      const spy = setupDimensionGesture()
      // A fresh pipeline starts dirty; make the state explicit anyway.
      pipeline.markDirty('test')

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(spy).not.toHaveBeenCalled()
    })

    it('finalises on a clean empty-space click', async () => {
      const spy = setupDimensionGesture()
      pipeline.target.markClean()

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([EDGE_LAYER_NAME]),
      }))

      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
      })

      expect(spy).toHaveBeenCalledWith([100, 100])
    })
  })

  // M2: hover and click must agree on what a stale-buffer null means. Click
  // already refuses to treat a dirty-buffer miss as empty space
  // (lastClickWasStale); hover now retains the current highlight rather than
  // tearing it down and flickering on every solver commit.
  describe('stale-buffer null hover', () => {
    it('retains the current highlight when the resolve lands null while the buffer is dirty', async () => {
      const onOver = vi.fn()
      const onOut = vi.fn()
      registerDimCallbacks('c1', { onOver, onOut, onClick: () => {}, onDoubleClick: () => {}, onPointerDown: () => {} })

      let nextHit: { layer: string; entityKey: string } | null = {
        layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1',
      }
      pipeline.resolveAsync = vi.fn().mockImplementation(async () => nextHit ? { ...nextHit, id: 1, distancePx: 0 } : null)

      // First move on a clean buffer establishes the highlight.
      pipeline.target.markClean()
      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
      }))
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
        await Promise.resolve()
      })
      expect(onOver).toHaveBeenCalledTimes(1)

      // The geometry is rebuilding: buffer goes dirty and the readback lands null.
      nextHit = null
      pipeline.markDirty('rebuild')
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, clientY: 50 }))
        await Promise.resolve()
      })
      await flushHoverFrame()
      // Highlight held: no onOut, and no redundant re-apply.
      expect(onOut).not.toHaveBeenCalled()
      expect(onOver).toHaveBeenCalledTimes(1)
    })

    it('still clears on a clean-buffer null', async () => {
      const onOver = vi.fn()
      const onOut = vi.fn()
      registerDimCallbacks('c1', { onOver, onOut, onClick: () => {}, onDoubleClick: () => {}, onPointerDown: () => {} })

      let nextHit: { layer: string; entityKey: string } | null = {
        layer: DIMENSION_LABEL_LAYER_NAME, entityKey: 'dim:c1',
      }
      pipeline.resolveAsync = vi.fn().mockImplementation(async () => nextHit ? { ...nextHit, id: 1, distancePx: 0 } : null)
      pipeline.target.markClean()

      renderHook(() => useIdBufferPointerDispatch({
        glRef: glRef as { current: import('three').WebGLRenderer | null },
        consumedLayers: new Set([DIMENSION_LABEL_LAYER_NAME]),
      }))
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 50 }))
        await Promise.resolve()
      })
      expect(onOver).toHaveBeenCalledTimes(1)

      // Buffer stays clean: a null here is genuine empty space.
      nextHit = null
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, clientY: 50 }))
        await Promise.resolve()
      })
      await flushHoverFrame()
      expect(onOut).toHaveBeenCalledTimes(1)
    })
  })
})
