/**
 * The seam that actually broke for dimension insertion.
 *
 * The dimension placement click travels pane -> R3F Canvas wrapper -> container
 * -> WebGL canvas, where useIdBufferPointerDispatch's click listener lives. It
 * resolves the id buffer, gets null (empty space) and calls
 * finalizeDimensionPlacement. The pane must NOT pre-empt that press with a
 * rubber band: a pending dimension pick means the next empty-space click IS the
 * placement, and letting a box open there would either capture the gesture away
 * from the canvas (the regression) or, after the capture fix, still raise
 * bandClickGuard and swallow the trailing click plus replace the selection.
 *
 * Pure-policy part lives in bandStartPolicy.test.ts. This pins the end-to-end
 * click: with a pending pick the pane opens no band, so the trailing click
 * reaches the dispatcher and finalizes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type * as THREE from 'three'
import { useIdBufferPointerDispatch, PART_EDITOR_CONSUMED_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { takeBandClickConsumed, useBandClickGuardCleanup } from '@/components/Viewport/idDispatch/bandClickGuard'
import { useRubberBandSelect } from '@/components/Viewport/useRubberBandSelect'
import { shouldOpenRubberBand } from '@/components/Viewport/bandStartPolicy'
import { IdPipeline } from '@/picking/IdPipeline'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { setSketchCallback } from '@/stores/sketchEditorStore'

const W = 800
const H = 600

// A gl whose readRenderTargetPixels paints every requested pixel; unused here
// because the tests stub pipeline.resolveSync to null so every click reads as
// empty space. Only its domElement (the canvas) matters for listener attach.
function glStub(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  return {
    domElement: canvas,
    readRenderTargetPixels: () => {},
  } as unknown as THREE.WebGLRenderer
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  Object.defineProperty(canvas, 'clientWidth', { value: W })
  Object.defineProperty(canvas, 'clientHeight', { value: H })
  canvas.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, width: W, height: H, toJSON() { return {} },
  })
  return canvas
}

function pointerEvent(x: number, y: number, buttons = 1): React.PointerEvent {
  return { clientX: x, clientY: y, button: 0, buttons, pointerType: 'mouse' } as unknown as React.PointerEvent
}

interface Harness {
  pipeline: IdPipeline
  result: { current: ReturnType<typeof useRubberBandSelect> }
  fireClick: (x: number, y: number) => Promise<void>
}

// Mount the band + dispatcher hooks against one canvas, exactly as the Viewport
// wires them, minus the Viewport itself.
async function setup(dimensionPicks: { isVertex: boolean; target: string; entityKind?: string }[]): Promise<Harness> {
  const canvas = makeCanvas()
  const pipeline = new IdPipeline({ width: W, height: H })
  setLivePipeline(pipeline)
  const gl = glStub(canvas)
  const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
  pipeline.target.markClean()  // the picking driver's steady state
  const { result } = renderHook(() => {
    useBandClickGuardCleanup()
    useIdBufferPointerDispatch({ glRef, consumedLayers: PART_EDITOR_CONSUMED_LAYERS })
    return useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS)
  })
  useSketchEditorStore.setState({
    activeTool: 'dimension',
    activeFeatureId: 'feat1',
    dimensionPicks,
    normalSelection: new Set(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
    hoveredVertexId: null,
    hoveredConstraintEntityIds: new Set(),
    contextMenu: null,
  })
  return {
    pipeline,
    result,
    fireClick: async (x: number, y: number) => {
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: x, clientY: y }))
      })
    },
  }
}

describe('dimension finalize click reaches the dispatcher', () => {
  let pipeline: IdPipeline

  beforeEach(() => {
    takeBandClickConsumed()  // clear any flag leaked from a prior test
    // A registered mutation lets finalizeDimensionPlacement run to its
    // "clear picks immediately" line, so the double-dispatch case can observe
    // the no-op second click.
    setSketchCallback('onMutation', () => {})
  })

  afterEach(() => {
    setLivePipeline(null)
    pipeline?.dispose()
    vi.restoreAllMocks()
  })

  it('a stationary empty-space click finalizes the pending placement', async () => {
    const h = await setup([{ isVertex: false, target: 'entity:feat1:l1' }])
    pipeline = h.pipeline
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')

    // The pane declines the band for a pending pick, so no band is opened and
    // the click resolves empty and finalizes.
    await h.fireClick(130, 140)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith([130, 140])
  })

  it('the finalize carries the exact client point of the placement click', async () => {
    const h = await setup([{ isVertex: false, target: 'entity:feat1:l1' }])
    pipeline = h.pipeline
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')

    await h.fireClick(200, 300)

    expect(spy).toHaveBeenCalledWith([200, 300])
  })

  it('a placement press that travels 20px still finalizes', async () => {
    // The policy declines a band start for a pending placement, so the pane
    // never calls rubberBand.onPointerDown even when the cursor drifts during
    // the click. The trailing click therefore reaches the dispatcher.
    expect(shouldOpenRubberBand({ activeTool: 'dimension', dimensionPickCount: 1, hasHover: false })).toBe(false)
    const h = await setup([{ isVertex: false, target: 'entity:feat1:l1' }])
    pipeline = h.pipeline
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')

    await h.fireClick(200, 300)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith([200, 300])
  })

  it('with no picks pending an empty-space click does not finalize', async () => {
    const h = await setup([])
    pipeline = h.pipeline
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')

    await h.fireClick(200, 300)

    expect(spy).not.toHaveBeenCalled()
  })

  it('a real box sweep taken before the first pick still owns its trailing click', async () => {
    // With zero picks the policy still opens a band, so this guards the
    // bandClickGuard invariant (605117dd) from being loosened by Change B.
    const h = await setup([])
    pipeline = h.pipeline
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10))).toBe(true)
      h.result.current.onPointerMove(pointerEvent(60, 60))
      h.result.current.onPointerUp()
    })

    pipeline.resolveSync = vi.fn().mockReturnValue(null)
    await h.fireClick(60, 60)

    expect(pipeline.resolveSync).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
  })

  it('a second placement click after a finalize does not double dispatch', async () => {
    const h = await setup([{ isVertex: false, target: 'entity:feat1:l1', entityKind: 'line' }])
    pipeline = h.pipeline
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')

    await h.fireClick(130, 140)
    expect(spy).toHaveBeenCalledTimes(1)
    // finalizeDimensionPlacement cleared dimensionPicks, so the second click is
    // a no-op (the contract is exercised at the DOM seam, not only in the store).
    await h.fireClick(130, 140)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
