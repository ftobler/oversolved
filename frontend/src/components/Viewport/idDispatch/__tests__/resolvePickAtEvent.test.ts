import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolvePickAtEvent } from '../useIdBufferPointerDispatch'
import { IdPipeline, EDGE_LAYER_NAME, VERTEX_LAYER_NAME } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'

// The single resolve seam shared by the click-selection dispatch and the
// project draw tool. These tests pin that contract so project can never drift
// back to reading the stale async hover (the flaky-edge-pick dual path).

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

const evt = (x: number, y: number) => new MouseEvent('pointerdown', { clientX: x, clientY: y })

describe('resolvePickAtEvent', () => {
  let canvas: HTMLCanvasElement
  let gl: StubRenderer
  let pipeline: IdPipeline

  beforeEach(() => {
    canvas = makeCanvas()
    gl = new StubRenderer(canvas)
    pipeline = new IdPipeline({ width: 800, height: 600 })
    setLivePipeline(pipeline)
  })
  afterEach(() => {
    setLivePipeline(null)
    pipeline.dispose()
  })

  it('returns the hit the pipeline resolves at the event pixel', () => {
    const EDGE_KEY = '?17;@gedge_abc:edge'
    const spy = vi.fn().mockReturnValue({ id: 3, layer: EDGE_LAYER_NAME, entityKey: EDGE_KEY, distancePx: 0 })
    pipeline.resolveSync = spy

    const hit = resolvePickAtEvent(
      evt(120, 90), canvas, gl as unknown as import('three').WebGLRenderer,
      new Set([EDGE_LAYER_NAME, VERTEX_LAYER_NAME]),
    )

    expect(hit?.entityKey).toBe(EDGE_KEY)
    // Resolved at the cursor (800px buffer over an 800px-wide rect -> 1:1).
    expect(spy).toHaveBeenCalledWith(gl, { x: 120, y: 90 }, { allowedLayers: new Set([EDGE_LAYER_NAME, VERTEX_LAYER_NAME]) })
  })

  it('a B-rep vertex query resolves through the same seam (drives the project point projection)', () => {
    const VERTEX_KEY = '?17;@gvertex_def:vertex'
    pipeline.resolveSync = vi.fn().mockReturnValue({ id: 4, layer: VERTEX_LAYER_NAME, entityKey: VERTEX_KEY, distancePx: 0 })

    const hit = resolvePickAtEvent(
      evt(200, 200), canvas, gl as unknown as import('three').WebGLRenderer,
      new Set([EDGE_LAYER_NAME, VERTEX_LAYER_NAME]),
    )

    expect(hit?.entityKey).toBe(VERTEX_KEY)
  })

  it('never resolves when no layer is allowed', () => {
    const spy = vi.fn()
    pipeline.resolveSync = spy

    const hit = resolvePickAtEvent(
      evt(10, 10), canvas, gl as unknown as import('three').WebGLRenderer, new Set(),
    )

    expect(hit).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})
