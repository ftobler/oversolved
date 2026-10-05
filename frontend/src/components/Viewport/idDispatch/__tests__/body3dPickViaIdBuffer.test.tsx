import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIdBufferPointerDispatch } from '../useIdBufferPointerDispatch'
import { IdPipeline, FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { StubRenderer, makeCanvas } from './pickCanvasFixture'

// B-rep click routing through the id-buffer dispatcher: a face/edge/vertex hit
// toggles normalSelection with exactly the clicked query (no @bodyId added),
// regardless of whether a pick field is active (the chip consumes downstream).

describe('body3dPickViaIdBuffer', () => {
  let canvas: HTMLCanvasElement
  let pipeline: IdPipeline
  let glRef: { current: unknown }
  let unmounts: Array<() => void>

  beforeEach(() => {
    unmounts = []
    canvas = makeCanvas()
    pipeline = new IdPipeline({ width: 800, height: 600 })
    // A never-rendered pipeline reads as dirty, which makes a null resolve a
    // transient miss; these cases stub a real hit, so pin it clean anyway.
    pipeline.isDirty = () => false
    setLivePipeline(pipeline)
    glRef = { current: new StubRenderer(canvas) }
    useSketchEditorStore.setState({
      activeTool: null,
      normalSelection: new Set(),
      activePickField: null,
      modeStack: [],
    })
  })

  afterEach(() => {
    for (const unmount of unmounts) unmount()
    setLivePipeline(null)
    pipeline.dispose()
  })

  function fireClickOn(layer: string, entityKey: string, pickKey?: string): void {
    pipeline.resolveSync = vi.fn().mockReturnValue({ id: 1, layer, entityKey, pickKey, distancePx: 0 })
    const { unmount } = renderHook(() => useIdBufferPointerDispatch({
      glRef: glRef as { current: import('three').WebGLRenderer | null },
      consumedLayers: new Set([layer]),
    }))
    unmounts.push(unmount)
    act(() => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })
  }

  it('face click toggles normalSelection with face query, not @bodyId', () => {
    fireClickOn(FACE_LAYER_NAME, '@feat1/face/0')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat1/face/0')).toBe(true)
    expect(sel.has('@feat1/b1')).toBe(false)
    expect(sel.size).toBe(1)
  })

  it('edge click toggles normalSelection with edge query, not @bodyId', () => {
    fireClickOn(EDGE_LAYER_NAME, '@feat2/edge/1')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat2/edge/1')).toBe(true)
    expect(sel.has('@feat2')).toBe(false)
    expect(sel.has('@feat2/b1')).toBe(false)
  })

  it('vertex click toggles normalSelection with vertex query, not @bodyId', () => {
    fireClickOn(VERTEX_LAYER_NAME, '@feat3/vertex/0')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat3/vertex/0')).toBe(true)
    expect(sel.size).toBe(1)
  })

  it('face click with a pick field active still toggles normalSelection (chip consumes downstream)', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'feat4', field: 'plane' })
    fireClickOn(FACE_LAYER_NAME, '@feat4/face/0')

    // No parallel plane-commit path: the click lands in normalSelection and
    // the active pick field consumes it via usePickField (Layer 2).
    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat4/face/0')).toBe(true)
  })
})
