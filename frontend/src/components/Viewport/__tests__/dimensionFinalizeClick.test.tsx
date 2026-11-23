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
import { render, renderHook, act } from '@testing-library/react'
import * as THREE from 'three'
import { useIdBufferPointerDispatch, PART_EDITOR_CONSUMED_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { takeBandClickConsumed, useBandClickGuardCleanup } from '@/components/Viewport/idDispatch/bandClickGuard'
import { useRubberBandSelect } from '@/components/Viewport/useRubberBandSelect'
import { shouldOpenRubberBand } from '@/components/Viewport/bandStartPolicy'
import { IdPipeline } from '@/picking/IdPipeline'
import { SKETCH_ENTITY_LAYER_NAME } from '@/picking/layerNames'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { setSketchCallback } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { initializeTools } from '@/tools'
import { DrawPlane } from '@/components/Geometry3D/Drawing'

// DrawPlane is mounted for the placement-point test only. It owns the window
// press that records the dimension cursor, so the canvas and camera it reads
// are per-test values.
const r3f = vi.hoisted(() => ({ camera: null as unknown, gl: null as unknown }))
vi.mock('@react-three/fiber', () => ({ useThree: () => ({ camera: r3f.camera, gl: r3f.gl }) }))
vi.mock('@react-three/drei', () => ({ Line: () => null }))
vi.mock('@/components/Geometry3D/VertexDots', () => ({ Dot: () => null }))
vi.mock('@/components/Geometry3D/dimensions', () => ({ DashedLine: () => null }))
// One world unit per 100 canvas pixels; the placement maths is the subject, not
// the ray/plane projection (pinned in Drawing.drawPlane.test.tsx).
const proj = vi.hoisted(() => ({ point: null as { x: number; y: number; z: number } | null }))
vi.mock('@/components/Geometry3D/dragMathPlane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/dragMathPlane')>()
  return {
    ...actual,
    projectCursorToSketchPlane: () => proj.point
      ? ({ x: proj.point.x, y: proj.point.y, z: proj.point.z } as unknown as THREE.Vector3)
      : null,
  }
})

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
    dimensionPicks,
  })
  useEditorState.setState({
    activeTool: 'dimension',
    activeFeatureId: 'feat1',
    normalSelection: new Set(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
    hoveredVertexId: null,
    hoveredConstraintEntityIds: new Set(),
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

// The reported gesture: pick the line, then place the label without moving the
// cursor. The placement point used to be a move-only side channel, so this
// click finalized with no cursor and the label landed at the renderer's far
// default offset until the next move snapped it back.
describe('a dimension placement click that never moved', () => {
  let pipeline: IdPipeline
  let canvas: HTMLCanvasElement

  beforeEach(() => {
    takeBandClickConsumed()
    initializeTools()
  })

  afterEach(() => {
    setLivePipeline(null)
    pipeline?.dispose()
    setSketchCallback('onMutation', null)
    setSketchCallback('getSketch', null)
    canvas?.remove()
    proj.point = null
    vi.restoreAllMocks()
  })

  it('lands the label at the press point instead of the default offset', async () => {
    canvas = makeCanvas()
    document.body.appendChild(canvas)
    pipeline = new IdPipeline({ width: W, height: H })
    setLivePipeline(pipeline)
    const gl = glStub(canvas)
    r3f.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
    r3f.gl = gl
    const groupRef = { current: new THREE.Group() }
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    setSketchCallback('getSketch', () => ({ L1: { start: [0, 0], end: [10, 0] } } as never))
    useEditorState.setState({
      activeTool: 'dimension',
      activeFeatureId: 'feat1',
      dimensionPicks: [],
      dimensionCursorWorld: null,
      entityKindMap: { 'entity:feat1:L1': 'line' },
      normalSelection: new Set(),
      hoveredSelectionId: null,
      hoveredVertexId: null,
      hoveredConstraintEntityIds: new Set(),
    })
    let hit: unknown = {
      id: 1, layer: SKETCH_ENTITY_LAYER_NAME, entityKey: 'entity:feat1:L1',
      pickKey: 'entity:feat1:L1', distancePx: 0,
    }
    pipeline.resolveSync = vi.fn(() => hit as never)
    pipeline.target.markClean()
    render(<DrawPlane featureId="feat1" activeFeatureId="feat1" sketchGroupRef={groupRef} />)
    renderHook(() => useIdBufferPointerDispatch({
      glRef: { current: gl } as React.RefObject<THREE.WebGLRenderer | null>,
      consumedLayers: PART_EDITOR_CONSUMED_LAYERS,
    }))

    // Pick the line: a press and its click, as the browser delivers them.
    proj.point = { x: 1, y: 1, z: 0 }
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }))
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 100, clientY: 100 }))
    })
    expect(useSketchEditorStore.getState().dimensionPicks).toHaveLength(1)

    // The placement click beside the line. No pointermove in between: the press
    // is the only thing that can name the placement point.
    hit = null
    proj.point = { x: 4, y: 4.2, z: 0 }
    pipeline.target.markClean()
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 420, bubbles: true }))
      canvas.dispatchEvent(new MouseEvent('click', { button: 0, clientX: 400, clientY: 420 }))
    })

    const dialog = useSketchUiStore.getState().pendingDialog
    expect(dialog).not.toBeNull()
    dialog!.onConfirm('10')

    // Length anchor = midpoint(L1) = (5, 0); the press point (4, 4.2) is the
    // label's anchor-relative pos, not the 10% extent default.
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_constraint',
      featureId: 'feat1', kind: 'length', targets: ['entity:feat1:L1'], value: 10,
      pos: [-1, 4.2],
    })
  })
})
