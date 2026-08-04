import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useIdBufferPointerDispatch,
  shouldClearSelectionOnBackplaneClick,
} from '../useIdBufferPointerDispatch'
import { IdPipeline, SKETCH_VERTEX_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { takeDrawToolClickConsumed } from '../drawToolClickGuard'

/**
 * Regression: the DrawPlane backplane used to clear the selection on every
 * sketch click. Sketch entities and vertices are visual-only (no R3F handler),
 * so clicks fall through to the backplane; the unguarded clear wiped the
 * just-toggled element, making it impossible to hold two selected at once
 * (e.g. two vertices to insert a constraint between them). The backplane now
 * defers to shouldClearSelectionOnBackplaneClick(), which mirrors the Canvas
 * onPointerMissed guard.
 */

class StubRenderer {
  domElement: HTMLCanvasElement
  constructor(canvas: HTMLCanvasElement) { this.domElement = canvas }
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 800; c.height = 600
  c.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} },
  })
  return c
}

describe('shouldClearSelectionOnBackplaneClick (backplane clear guard)', () => {
  let canvas: HTMLCanvasElement
  let pipeline: IdPipeline
  let glRef: { current: unknown }

  beforeEach(() => {
    canvas = makeCanvas()
    pipeline = new IdPipeline({ width: 800, height: 600 })
    // A never-rendered pipeline reads as dirty; a null resolve on a dirty
    // buffer is treated as "stale", not "empty space". Real usage renders the
    // buffer every frame, so pin it clean here.
    pipeline.isDirty = () => false
    setLivePipeline(pipeline)
    glRef = { current: new StubRenderer(canvas) }
    useSketchEditorStore.setState({ activeTool: null, normalSelection: new Set() })
    takeDrawToolClickConsumed()  // clear any flag leaked from a prior test
  })
  afterEach(() => {
    setLivePipeline(null)
    pipeline.dispose()
  })

  function fireClick() {
    canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
  }

  it('does NOT clear after a click the id-buffer consumed (sketch vertex hit)', async () => {
    pipeline.resolveSync = () => ({
      id: 2, layer: SKETCH_VERTEX_LAYER_NAME, entityKey: 'vertex:S1:P1:xy', distancePx: 0,
    })
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
    }))

    await act(async () => { fireClick() })

    expect(shouldClearSelectionOnBackplaneClick()).toBe(false)
  })

  it('does NOT clear after a click the id-buffer consumed (sketch entity hit)', async () => {
    pipeline.resolveSync = () => ({
      id: 3, layer: SKETCH_ENTITY_LAYER_NAME, entityKey: 'entity:S1:L1', distancePx: 0,
    })
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_ENTITY_LAYER_NAME]),
    }))

    await act(async () => { fireClick() })

    expect(shouldClearSelectionOnBackplaneClick()).toBe(false)
  })

  it('DOES clear after a click on empty space (no hit)', async () => {
    pipeline.resolveSync = () => null
    renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([SKETCH_VERTEX_LAYER_NAME]),
    }))

    await act(async () => { fireClick() })

    expect(shouldClearSelectionOnBackplaneClick()).toBe(true)
  })
})
