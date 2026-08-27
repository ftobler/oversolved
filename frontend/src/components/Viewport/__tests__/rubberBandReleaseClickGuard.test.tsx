/**
 * VP-M1 regression: the rubber-band release double dispatch.
 *
 * A band commits the boxed set on pointerup; the browser then fires the
 * native click the same gesture produced, and the id-buffer dispatcher used
 * to resolve that RELEASE pixel with no drag guard, toggling whatever
 * sub-shape sat under the sweep's end cursor on top of the box it just
 * committed (or finalizing pending dimension picks when the sweep ended over
 * empty space). These tests drive BOTH hooks against one canvas through the
 * real seam: band pointer events go through the hook API, the trailing click
 * goes through the dispatcher's canvas listener. Hook-isolated band tests
 * hide this bug entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type * as THREE from 'three'
import { useIdBufferPointerDispatch, wasLastClickConsumedByIdDispatch, PART_EDITOR_CONSUMED_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { takeBandClickConsumed, useBandClickGuardCleanup } from '@/components/Viewport/idDispatch/bandClickGuard'
import { useRubberBandSelect } from '@/components/Viewport/useRubberBandSelect'
import { IdPipeline } from '@/picking/IdPipeline'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { EDGE_LAYER_NAME } from '@/picking/layerNames'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

const W = 800
const H = 600

// A gl whose readRenderTargetPixels paints every requested pixel with the RGB
// encoding of entityId, so the band's crossing read collects that entity.
function glPainting(entityId: number, canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const r = (entityId >> 16) & 0xFF
  const g = (entityId >> 8) & 0xFF
  const b = entityId & 0xFF
  return {
    domElement: canvas,
    readRenderTargetPixels: (
      _t: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array,
    ) => {
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = r
        buf[i * 4 + 1] = g
        buf[i * 4 + 2] = b
        buf[i * 4 + 3] = 255
      }
    },
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

// Render the dispatcher and the band hook in ONE component sharing glRef:
// the exact interplay the Viewport wires up, minus the Viewport itself.
// `boxedKey` is allocated and painted, so a sweep commits it as selection.
async function setup(boxedKey: string): Promise<Harness> {
  const canvas = makeCanvas()
  const pipeline = new IdPipeline({ width: W, height: H })
  setLivePipeline(pipeline)
  const gl = glPainting(pipeline.registry.allocate(EDGE_LAYER_NAME, boxedKey), canvas)
  const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
  pipeline.target.markClean()  // the picking driver's steady state
  const { result } = renderHook(() => {
    useBandClickGuardCleanup()
    useIdBufferPointerDispatch({ glRef, consumedLayers: PART_EDITOR_CONSUMED_LAYERS })
    return useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS)
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

describe('band release vs the trailing native click (VP-M1)', () => {
  let pipeline: IdPipeline

  beforeEach(() => {
    takeBandClickConsumed()  // clear any flag leaked from a prior test
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: null,
      isRotating: false,
      normalSelection: new Set(),
      selectedPicks: new Map(),
      dimensionPicks: [],
      hoveredSelectionId: null,
      hoveredVertexId: null,
      hoveredConstraintEntityIds: new Set(),
    })
  })

  afterEach(() => {
    setLivePipeline(null)
    pipeline?.dispose()
    vi.restoreAllMocks()
  })

  it('a sweep ending over an entity commits the box; the trailing click does not toggle the release pixel', async () => {
    const key = 'sk1/eBoxed'
    const h = await setup(key)
    pipeline = h.pipeline

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      h.result.current.onPointerMove(pointerEvent(60, 60))
      h.result.current.onPointerUp()
    })
    expect([...useSketchEditorStore.getState().normalSelection]).toEqual([key])

    // The release pixel sits ON the entity the box just selected: the old
    // behavior resolved it here and toggled the key straight back out.
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 1, layer: EDGE_LAYER_NAME, entityKey: key, distancePx: 0,
    })
    await h.fireClick(60, 60)

    expect(pipeline.resolveSync).not.toHaveBeenCalled()  // honored before onClick resolves
    expect([...useSketchEditorStore.getState().normalSelection]).toEqual([key])
    expect(wasLastClickConsumedByIdDispatch()).toBe(true)  // onPointerMissed must not wipe the box either
  })

  it('a sweep ending over empty space does not finalize pending dimension picks', async () => {
    const h = await setup('sk1/painted')
    pipeline = h.pipeline
    useSketchEditorStore.setState({
      activeTool: 'dimension',
      activeFeatureId: 'feat1',
      dimensionPicks: [{ isVertex: false, target: 'entity:feat1:l1' }],
    })
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      h.result.current.onPointerMove(pointerEvent(60, 60))
      h.result.current.onPointerUp()
    })

    pipeline.resolveSync = vi.fn().mockReturnValue(null)
    await h.fireClick(60, 60)

    expect(pipeline.resolveSync).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
  })

  it('a pointercancel teardown consumes the trailing click', async () => {
    const h = await setup('sk1/painted')
    pipeline = h.pipeline
    useSketchEditorStore.getState().toggleNormalSelection('sk1/keep')

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      h.result.current.onPointerMove(pointerEvent(40, 40))
      h.result.current.onPointerCancel()
    })

    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 2, layer: EDGE_LAYER_NAME, entityKey: 'sk1/keep', distancePx: 0,
    })
    await h.fireClick(40, 40)

    expect(pipeline.resolveSync).not.toHaveBeenCalled()
    // No ghost toggle out of the pre-existing selection either way.
    expect(useSketchEditorStore.getState().normalSelection.has('sk1/keep')).toBe(true)
  })

  it('a stranded band (release never seen, move with no button held) consumes the trailing click', async () => {
    const h = await setup('sk1/painted')
    pipeline = h.pipeline

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      h.result.current.onPointerMove(pointerEvent(40, 40))
      h.result.current.onPointerMove(pointerEvent(60, 60, 0))
    })
    expect(h.result.current.state.dragging).toBe(false)

    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 3, layer: EDGE_LAYER_NAME, entityKey: 'sk1/lateToggle', distancePx: 0,
    })
    await h.fireClick(60, 60)

    expect(pipeline.resolveSync).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.has('sk1/lateToggle')).toBe(false)
  })

  it('a stranded flag does not eat the NEXT gesture\'s click', async () => {
    const h = await setup('sk1/painted')
    pipeline = h.pipeline

    // Strand a band, leaving the flag with no trailing click to consume it.
    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      h.result.current.onPointerMove(pointerEvent(40, 40))
      h.result.current.onPointerMove(pointerEvent(60, 60, 0))
    })

    // A fresh gesture begins: its window pointerdown clears the stale flag...
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }))
    })

    // ...so this genuine empty-space-style click resolves normally.
    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 4, layer: EDGE_LAYER_NAME, entityKey: 'sk1/fresh', distancePx: 0,
    })
    await h.fireClick(20, 20)

    expect(pipeline.resolveSync).toHaveBeenCalledTimes(1)
    expect(useSketchEditorStore.getState().normalSelection.has('sk1/fresh')).toBe(true)
  })

  it('a stationary press on empty space keeps normal click semantics', async () => {
    // The fix must stay narrow: a press that never drew a visible box (<4px)
    // is an ordinary click -- deselect, dimension finalize and toggles ride
    // on it -- so its teardown must not raise the band flag at all.
    const h = await setup('sk1/painted')
    pipeline = h.pipeline

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      h.result.current.onPointerUp()  // no move: rectRef stays null
    })

    pipeline.resolveSync = vi.fn().mockReturnValue({
      id: 5, layer: EDGE_LAYER_NAME, entityKey: 'sk1/clickPick', distancePx: 0,
    })
    await h.fireClick(10, 10)

    expect(pipeline.resolveSync).toHaveBeenCalledTimes(1)
    expect(useSketchEditorStore.getState().normalSelection.has('sk1/clickPick')).toBe(true)
  })

  it('an opened box raises the band flag, a stationary press still does not, after the capture move', async () => {
    // The pane now takes capture on the move that first opens a box, so the
    // trailing-click guard it raises must stay coupled to that transition: a box
    // raises the flag, a stationary press (no move past 4px) must not.
    const h = await setup('sk1/painted')
    pipeline = h.pipeline

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      expect(h.result.current.onPointerMove(pointerEvent(60, 60))).toBe(true)
      h.result.current.onPointerUp()
    })
    // The visible-box open raised the band flag so the trailing click is swallowed.
    expect(takeBandClickConsumed()).toBe(true)

    await act(async () => {
      expect(h.result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      expect(h.result.current.onPointerMove(pointerEvent(11, 10))).toBe(false)  // under 4px
      h.result.current.onPointerUp()
    })
    // A stationary press raises no flag.
    expect(takeBandClickConsumed()).toBe(false)
  })
})
