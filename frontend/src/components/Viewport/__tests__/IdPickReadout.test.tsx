import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import type * as THREE from 'three'
import IdPickReadout from '../IdPickReadout'
import { PART_EDITOR_CONSUMED_LAYERS } from '../idDispatch/useIdBufferPointerDispatch'
import { DIMENSION_LABEL_LAYER_NAME } from '@/picking/layerNames'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

/**
 * The pick readout exists to make a "cannot select this" report decidable: it
 * prints which entity the click would take, or says explicitly that the buffer
 * was mid-rebuild / that no pipeline was live / that the disc was empty. These
 * tests drive the real pointer listener and assert those distinctions survive.
 */

type FakePipeline = {
  isDirty: () => boolean
  resolveAllSync: ReturnType<typeof vi.fn>
}

const live = vi.hoisted(() => ({ pipeline: null as FakePipeline | null }))

vi.mock('@/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/picking')>()),
  getLivePipeline: () => live.pipeline,
}))

let canvas: HTMLCanvasElement
let gl: { domElement: HTMLCanvasElement }

function installCanvas(width = 200, height = 100, rectW = 100, rectH = 50) {
  canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width: rectW, height: rectH,
    right: rectW, bottom: rectH, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect
  gl = { domElement: canvas }
}

function makePipeline(dirty: boolean, hits: unknown[] = []): FakePipeline {
  return {
    isDirty: () => dirty,
    resolveAllSync: vi.fn(() => hits),
  }
}

function move(clientX: number, clientY: number) {
  act(() => {
    canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX, clientY }))
  })
}

beforeEach(() => {
  live.pipeline = null
  installCanvas()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('IdPickReadout', () => {
  it('reports a missing live pipeline rather than an empty scene', () => {
    live.pipeline = null
    const { getByText } = render(<IdPickReadout glRef={{ current: gl as unknown as THREE.WebGLRenderer }} />)
    move(10, 10)
    expect(getByText('no live pipeline')).toBeInTheDocument()
  })

  it('calls out a dirty id buffer, because every resolve is null then', () => {
    live.pipeline = makePipeline(true)
    const { getByText } = render(<IdPickReadout glRef={{ current: gl as unknown as THREE.WebGLRenderer }} />)
    move(10, 10)
    expect(getByText('id buffer DIRTY -- every resolve returns null')).toBeInTheDocument()
    expect(live.pipeline!.resolveAllSync).not.toHaveBeenCalled()
  })

  it('says the disc was empty when the resolve found nothing', () => {
    live.pipeline = makePipeline(false, [])
    const { getByText } = render(<IdPickReadout glRef={{ current: gl as unknown as THREE.WebGLRenderer }} />)
    move(10, 10)
    expect(getByText('nothing in the pick disc')).toBeInTheDocument()
  })

  it('prints the candidate list, marks the winner and shows the device-pixel cursor', () => {
    live.pipeline = makePipeline(false, [
      { id: 5, entityKey: 'face:body1:?1', layer: 'face', distancePx: 3.14159 },
      { id: 9, entityKey: 'edge:body1:e2', layer: 'edge', distancePx: 8 },
    ])
    const { container, getByText } = render(
      <IdPickReadout glRef={{ current: gl as unknown as THREE.WebGLRenderer }} />,
    )

    // client (50,25) over a 100x50 element backing 200x100 px -> (100,50).
    move(50, 25)

    expect(getByText(/@ 100\.0, 50\.0 device px/)).toBeInTheDocument()
    expect(getByText(/tool=idle/)).toBeInTheDocument()
    const rows = container.querySelectorAll('div[style*="margin-top"]')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('> #5 face d=3.14')
    expect(rows[0].textContent).toContain('face:body1:?1')
    expect(rows[1].textContent).toContain('#9 edge d=8.00')
  })

  it('passes the active tool to the note and filters layers through the tool policy', () => {
    live.pipeline = makePipeline(false, [{ id: 1, entityKey: 'entity:S1:l1', layer: 'sketchEntity', distancePx: 2 }])
    const { getByText } = render(<IdPickReadout glRef={{ current: gl as unknown as THREE.WebGLRenderer }} />)
    act(() => { useSketchEditorStore.setState({ activeTool: 'rect' }) })
    move(10, 10)

    expect(getByText(/tool=rect/)).toBeInTheDocument()
    const call = live.pipeline!.resolveAllSync.mock.calls[0]
    const allowed = call[2].allowedLayers as ReadonlySet<string>
    // The draw tool's policy excludes dimension labels; the debug readout must
    // report the same filtered set the click routes through.
    expect(PART_EDITOR_CONSUMED_LAYERS.has(DIMENSION_LABEL_LAYER_NAME)).toBe(true)
    expect(allowed.has(DIMENSION_LABEL_LAYER_NAME)).toBe(false)
  })

  it('coalesces rapid moves into one resolve per animation frame', () => {
    live.pipeline = makePipeline(false, [])
    let rafCb: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { rafCb = cb; return 1 }))

    render(<IdPickReadout glRef={{ current: gl as unknown as THREE.WebGLRenderer }} />)
    move(10, 10)
    move(20, 20)

    // The second move is queued, not resolved: a resolve is a blocking readback.
    expect(live.pipeline!.resolveAllSync).toHaveBeenCalledTimes(1)

    act(() => rafCb!(0))
    expect(live.pipeline!.resolveAllSync).toHaveBeenCalledTimes(2)
  })

  it('ignores a pointer over a zero-sized element instead of dividing by zero', () => {
    installCanvas(200, 100, 0, 0)
    live.pipeline = makePipeline(false, [])
    const { queryByText } = render(<IdPickReadout glRef={{ current: gl as unknown as THREE.WebGLRenderer }} />)
    move(10, 10)
    expect(live.pipeline!.resolveAllSync).not.toHaveBeenCalled()
    expect(queryByText(/device px/)).toBeNull()
  })
})
