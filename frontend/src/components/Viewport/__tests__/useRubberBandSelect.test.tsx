/**
 * Rubber-band select tests.
 *
 * Two responsibilities are pinned here:
 *  1. The band must mirror the id-buffer dispatcher's swallow semantics: a
 *     crossing sweep over featureHandle / dimensionLabel pixels commits
 *     nothing, no matter how lax the tool's allowedLayers filter is (idle
 *     select has allowedLayers === null, i.e. no filter).
 *  2. A committed box REPLACES the current selection (Option A, 2026-08-05):
 *     the boxed set is the whole selection. It is query-only, never
 *     per-primitive, so no pickKey is minted and selectionDomain is re-derived.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { IdPipeline } from '@/picking/IdPipeline'
import { getLivePipeline, setLivePipeline } from '@/picking/IdPipelineContext'
import { FACE_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME } from '@/picking/layerNames'
import { FEATURE_HANDLE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME } from '@/picking/layerNames'
import { PART_EDITOR_CONSUMED_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { takeBandClickConsumed } from '@/components/Viewport/idDispatch/bandClickGuard'
import { useRubberBandSelect } from '../useRubberBandSelect'

const PIPELINE_W = 100
const PIPELINE_H = 100

// A gl whose readRenderTargetPixels paints every requested pixel with the RGB
// encoding of `entityId`, so a crossing sweep over the rect collects that one
// entity.
function glForEntityId(entityId: number) {
  const readRenderTargetPixels = vi.fn(
    (_target: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array) => {
      const r = (entityId >> 16) & 0xFF
      const g = (entityId >> 8) & 0xFF
      const b = entityId & 0xFF
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = r
        buf[i * 4 + 1] = g
        buf[i * 4 + 2] = b
        buf[i * 4 + 3] = 255
      }
    },
  )
  const canvas = {
    clientWidth: PIPELINE_W,
    clientHeight: PIPELINE_H,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: PIPELINE_W, height: PIPELINE_H }),
  } as unknown as HTMLCanvasElement
  const gl = { domElement: canvas, readRenderTargetPixels } as unknown as THREE.WebGLRenderer
  return { gl, readRenderTargetPixels }
}

// A gl that paints each read pixel by `paint(col, row)` (read-buffer coords,
// row 0 = bottom, matching readRenderTargetPixels). `null` paints empty space.
// Lets a test split one box between two entity ids.
function glForPaint(paint: (col: number, row: number) => number | null) {
  const readRenderTargetPixels = vi.fn(
    (_target: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array) => {
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const id = paint(col, row)
          const i = (row * w + col) * 4
          if (id === null) {
            buf[i + 3] = 0
          } else {
            buf[i] = (id >> 16) & 0xFF
            buf[i + 1] = (id >> 8) & 0xFF
            buf[i + 2] = id & 0xFF
            buf[i + 3] = 255
          }
        }
      }
    },
  )
  const canvas = {
    clientWidth: PIPELINE_W,
    clientHeight: PIPELINE_H,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: PIPELINE_W, height: PIPELINE_H }),
  } as unknown as HTMLCanvasElement
  const gl = { domElement: canvas, readRenderTargetPixels } as unknown as THREE.WebGLRenderer
  return { gl, readRenderTargetPixels }
}

function pointerEvent(
  x: number,
  y: number,
  buttons = 1,
  pointerType: string = 'mouse',
): React.PointerEvent {
  // buttons defaults to pressed-left: the value every real pointermove while
  // dragging carries. Tests pass 0 explicitly for the stranded-release case.
  // pointerType defaults to mouse: real mouse events always carry it, so the
  // existing sweeps keep simulating ordinary mice.
  return { clientX: x, clientY: y, button: 0, buttons, pointerType } as unknown as React.PointerEvent
}

function resetStore(): void {
  useSketchEditorStore.setState({
    activeTool: null,
    isRotating: false,
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
  })
}

// Drive the full box drag (down, move, up) with the given gl.
function sweepWith(gl: THREE.WebGLRenderer): void {
  const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
  const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
  // Production commits only ever run against a settled buffer: the picking
  // driver re-renders the ID target every frame, so clean is the normal state.
  getLivePipeline()?.target.markClean()
  act(() => {
    result.current.onPointerDown(pointerEvent(10, 10), false)
    result.current.onPointerMove(pointerEvent(40, 40))
    result.current.onPointerUp()
  })
}

// Sweep a box from (10,10) to (40,40) with idle select active, driving the hook
// with the PRODUCTION consumed set (the same PART_EDITOR_CONSUMED_LAYERS the
// Viewport builds, featureHandle and dimensionLabel included).
function sweep(entityId: number): void {
  const { gl } = glForEntityId(entityId)
  sweepWith(gl)
}

function selectedKeys(): string[] {
  return [...useSketchEditorStore.getState().normalSelection]
}

beforeEach(resetStore)

describe('useRubberBandSelect band start gates', () => {
  it('does not start on a non-left button', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    const started = result.current.onPointerDown(
      { clientX: 10, clientY: 10, button: 2 } as unknown as React.PointerEvent,
      false,
    )
    expect(started).toBe(false)
  })

  it('does not start on an id-buffer hit', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    expect(result.current.onPointerDown(pointerEvent(10, 10), true)).toBe(false)
  })

  it('does not start while the camera is rotating', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    useSketchEditorStore.setState({ isRotating: true })
    expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(false)
  })

  it('starts on a left-click on empty space while idle', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
  })

  // The drag flag means "a box is open", not "a press is live". A stationary
  // press arms the band but opens nothing, and the Viewport publishes this flag
  // at pointer-up for the sketch backplane's empty-click deselect: raising it on
  // the press made every in-sketch click look like the tail of a sweep, and
  // deselection by clicking the background died.
  it('a press that never opens a box leaves the drag flag down', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    act(() => { result.current.onPointerDown(pointerEvent(10, 10), false) })
    expect(result.current.state.isDraggingRef.current).toBe(false)
    // A sub-threshold twitch is still no box.
    act(() => { result.current.onPointerMove(pointerEvent(12, 12)) })
    expect(result.current.state.isDraggingRef.current).toBe(false)
  })

  // L27: band-start reads the async hover state as its geometry guard, and
  // touch/pen first contact has no hover resolved yet -- a finger landing on a
  // body would open a box over geometry instead of selecting it. Until a sync
  // resolve is designed, only mouse pointers start a band.
  it('does not start for touch contact', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    expect(result.current.onPointerDown(pointerEvent(10, 10, 1, 'touch'), false)).toBe(false)
    expect(result.current.state.isDraggingRef.current).toBe(false)
  })

  it('does not start for pen contact', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    expect(result.current.onPointerDown(pointerEvent(10, 10, 1, 'pen'), false)).toBe(false)
  })

  it('a mouse press on empty space still starts and commits a band', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const entityId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eB')
      p.markDirty('edit')
      p.target.markClean()  // the driver's next-frame re-render
      sweep(entityId)  // helper events carry pointerType 'mouse'
      expect(selectedKeys()).toEqual(['sk1/eB'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})

describe('useRubberBandSelect replace semantics (Option A)', () => {
  it('a fresh box replaces the current selection with the boxed set', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const bId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eB')
      // A pre-existing selection outside the box must not survive the box.
      useSketchEditorStore.getState().toggleNormalSelection('sk1/eA')
      sweep(bId)
      expect(selectedKeys()).toEqual(['sk1/eB'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('a box never deselects a covered entity it re-covers', () => {
    // Regression: the old per-entity toggle loop deselected an already-selected
    // covered entity (edge A, then a box over A+B gave {B}).
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const eId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/e3')
      useSketchEditorStore.getState().toggleNormalSelection('sk1/e3')
      sweep(eId)
      expect(selectedKeys()).toEqual(['sk1/e3'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('a box over two entities selects exactly those two', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const aId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eA')
      const bId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eB')
      // Read-buffer rows are bottom-up (row 0 = bottom of the box), so
      // `row < 15` paints the BOTTOM half with A and the top half with B.
      const { gl } = glForPaint((_col, row) => (row < 15 ? aId : bId))
      sweepWith(gl)
      expect(selectedKeys().sort()).toEqual(['sk1/eA', 'sk1/eB'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('recomputes selectionDomain from the boxed set', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const faceId = p.registry.allocate(FACE_LAYER_NAME, '@feat1/face/0')
      useSketchEditorStore.getState().toggleNormalSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
      sweep(faceId)
      expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('mints no pickKey: the boxed selection is query-only', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const faceId = p.registry.allocate(FACE_LAYER_NAME, '@feat1/face/0')
      sweep(faceId)
      const s = useSketchEditorStore.getState()
      expect(s.normalSelection.has('@feat1/face/0')).toBe(true)
      expect(s.selectedPicks.size).toBe(0)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})

describe('useRubberBandSelect stale-buffer guard', () => {
  // Manual drive, NOT sweepWith: that helper settles the buffer first, which
  // is exactly the state under test here.
  function rawSweep(entityId: number): void {
    const { gl } = glForEntityId(entityId)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    act(() => {
      result.current.onPointerDown(pointerEvent(10, 10), false)
      result.current.onPointerMove(pointerEvent(40, 40))
      result.current.onPointerUp()
    })
  }

  it('commits nothing while the id buffer is dirty at pointer-up', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const bId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eB')
      useSketchEditorStore.getState().toggleNormalSelection('sk1/keep')
      p.markDirty('edit')  // pixels predate the edit; a commit would read stale ids
      rawSweep(bId)
      expect(selectedKeys()).toEqual(['sk1/keep'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('commits the boxed entity once the buffer is clean again', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const bId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eB')
      p.markDirty('edit')
      p.target.markClean()  // the driver's next-frame re-render
      sweep(bId)
      expect(selectedKeys()).toEqual(['sk1/eB'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})

describe('useRubberBandSelect degenerate-rect exit', () => {
  it('releases the drag flag when the scaled box rounds away at the buffer edge', () => {
    // Browser zoom under 100% leaves the drawing buffer smaller than the CSS
    // size, so a band starting ~1px inside the right edge scales to exactly
    // the buffer width: rw rounds down to 0 and the commit exits early. That
    // exit must still release isDraggingRef, or Viewport's onPointerMissed
    // suppresses empty-space deselect for every later stationary click.
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const { gl } = glForEntityId(0)
      ;(gl.domElement as unknown as { clientWidth: number }).clientWidth = PIPELINE_W * 2
      const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
      const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
      getLivePipeline()?.target.markClean()
      act(() => {
        expect(result.current.onPointerDown(pointerEvent(199.5, 10), false)).toBe(true)
        result.current.onPointerMove(pointerEvent(260, 40))
        result.current.onPointerUp()
      })
      expect(result.current.state.isDraggingRef.current).toBe(false)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})

describe('useRubberBandSelect off-pane release guards', () => {
  // Manual drive, not sweepWith: these tests need the drag to be LIVE when
  // the stranded move or the cancel arrives.
  function liveDrag(entityId: number) {
    const { gl } = glForEntityId(entityId)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const result = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS)).result
    getLivePipeline()?.target.markClean()
    return result
  }

  it('drops a stranded band when a move arrives with no button held', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const entityId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eB')
      useSketchEditorStore.getState().toggleNormalSelection('sk1/keep')
      const result = liveDrag(entityId)
      act(() => {
        expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
        result.current.onPointerMove(pointerEvent(40, 40))
        expect(result.current.state.isDraggingRef.current).toBe(true)
        // The release landed outside the pane, so moves keep arriving with
        // the pre-capture ghost box under the free cursor. That is the strand.
        result.current.onPointerMove(pointerEvent(60, 60, 0))
      })
      expect(result.current.state.isDraggingRef.current).toBe(false)
      expect(result.current.state.dragging).toBe(false)
      // A late up after the drop must stay inert, and the old selection must
      // have survived untouched.
      act(() => { result.current.onPointerUp() })
      expect(selectedKeys()).toEqual(['sk1/keep'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('onPointerCancel abandons the band without committing and frees the next drag', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const entityId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/eB')
      const result = liveDrag(entityId)
      act(() => {
        expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
        result.current.onPointerMove(pointerEvent(40, 40))
        result.current.onPointerCancel()
      })
      expect(result.current.state.isDraggingRef.current).toBe(false)
      expect(selectedKeys()).toEqual([])
      // The gesture the browser tore away must not wedge the hook: the next
      // press starts a fresh band and commits normally.
      act(() => {
        expect(result.current.onPointerDown(pointerEvent(20, 20), false)).toBe(true)
        result.current.onPointerMove(pointerEvent(60, 60))
        result.current.onPointerUp()
      })
      expect(selectedKeys()).toEqual(['sk1/eB'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})

describe('useRubberBandSelect commit readback equivalence', () => {
  // A gl backed by a synthetic framebuffer in TARGET pixel coordinates
  // (bottom-origin rows, matching readRenderTargetPixels), so a test can
  // paint exact geometry and the hook's chunked reads slice it faithfully.
  function glForFramebuffer(w: number, h: number, paint: (col: number, row: number) => number | null) {
    const fb = new Uint8Array(w * h * 4)
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const id = paint(col, row)
        const i = (row * w + col) * 4
        if (id !== null) {
          fb[i] = (id >> 16) & 0xFF
          fb[i + 1] = (id >> 8) & 0xFF
          fb[i + 2] = id & 0xFF
          fb[i + 3] = 255
        }
      }
    }
    const readRenderTargetPixels = vi.fn(
      (_target: unknown, gx: number, gy: number, rw: number, rh: number, buf: Uint8Array) => {
        for (let r = 0; r < rh; r++) {
          for (let c = 0; c < rw; c++) {
            const si = ((gy + r) * w + (gx + c)) * 4
            const di = (r * rw + c) * 4
            buf[di] = fb[si]
            buf[di + 1] = fb[si + 1]
            buf[di + 2] = fb[si + 2]
            buf[di + 3] = fb[si + 3]
          }
        }
      },
    )
    const canvas = {
      clientWidth: w,
      clientHeight: h,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    } as unknown as HTMLCanvasElement
    return { gl: { domElement: canvas, readRenderTargetPixels } as unknown as THREE.WebGLRenderer, readRenderTargetPixels }
  }

  it('a small band selects exactly the entities its pixels touch', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const aId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/lineA')
      const bId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/lineB')
      const cId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/outside')
      // A horizontal stroke and a vertical stroke crossing the band, plus a
      // speck outside it that must stay unselected. Painted conditions are in
      // top-origin canvas coords; `ty` converts from framebuffer rows.
      const { gl } = glForFramebuffer(PIPELINE_W, PIPELINE_H, (col, row) => {
        const ty = PIPELINE_H - 1 - row
        if (ty === 20 && col >= 10 && col <= 60) return aId
        if (col === 30 && ty >= 10 && ty <= 60) return bId
        if (col >= 80 && col <= 82 && ty >= 80 && ty <= 82) return cId
        return null
      })
      const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
      const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
      getLivePipeline()?.target.markClean()
      act(() => {
        result.current.onPointerDown(pointerEvent(10, 10), false)
        result.current.onPointerMove(pointerEvent(60, 60))
        result.current.onPointerUp()
      })
      expect(selectedKeys().sort()).toEqual(['sk1/lineA', 'sk1/lineB'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('a band over the read budget chunks its reads and still visits every pixel', () => {
    // 1190x890 device px exceeds BAND_READ_BUDGET_PIXELS, so the commit runs
    // through planBandReads' chunk path. The isolated 3x3 speck is exactly the
    // content any strided subsampling would lose; equivalence here pins that
    // chunking changed the working set only, never the selected set.
    const W = 1200
    const H = 900
    const p = new IdPipeline({ width: W, height: H })
    setLivePipeline(p)
    try {
      const aId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/wideLine')
      const bId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/tallLine')
      const cId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/speck')
      const dId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/outside')
      // Painted conditions are in top-origin canvas coords; `ty` converts
      // from framebuffer rows. The band is css (5,5)-(1195,895).
      const { gl, readRenderTargetPixels } = glForFramebuffer(W, H, (col, row) => {
        const ty = H - 1 - row
        if (ty === 450 && col >= 10 && col <= 1190) return aId
        if (col === 600 && ty >= 10 && ty <= 890) return bId
        if (col >= 900 && col <= 902 && ty >= 700 && ty <= 702) return cId
        if (col <= 2 && ty <= 2) return dId
        return null
      })
      const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
      const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
      getLivePipeline()?.target.markClean()
      act(() => {
        result.current.onPointerDown(pointerEvent(5, 5), false)
        result.current.onPointerMove(pointerEvent(1195, 895))
        result.current.onPointerUp()
      })
      expect(selectedKeys().sort()).toEqual(['sk1/speck', 'sk1/tallLine', 'sk1/wideLine'])
      // The budget was actually exceeded: more than one read ran.
      expect(readRenderTargetPixels.mock.calls.length).toBeGreaterThan(1)
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})

describe('useRubberBandSelect honors the dispatcher swallow semantics', () => {
  it('a sweep over a featureHandle pixel with idle select collects nothing', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const handleId = p.registry.allocate(FEATURE_HANDLE_LAYER_NAME, 'fhandle:extrude1')
      sweep(handleId)
      expect(selectedKeys()).toEqual([])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('a sweep over a dimension-label pixel collects nothing', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const dimId = p.registry.allocate(DIMENSION_LABEL_LAYER_NAME, 'dim:c1')
      sweep(dimId)
      expect(selectedKeys()).toEqual([])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('a sweep over sketch entities still selects them', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const entityId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'sk1/e3')
      sweep(entityId)
      expect(selectedKeys()).toEqual(['sk1/e3'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })

  it('a sweep over B-rep geometry still selects it under idle select', () => {
    const p = new IdPipeline({ width: PIPELINE_W, height: PIPELINE_H })
    setLivePipeline(p)
    try {
      const faceId = p.registry.allocate(FACE_LAYER_NAME, '@feat1/face/0')
      sweep(faceId)
      expect(selectedKeys()).toEqual(['@feat1/face/0'])
    } finally {
      setLivePipeline(null)
      p.dispose()
    }
  })
})

// The visible-box transition is the capture trigger. A press that never becomes
// a box must keep its own click target (the gizmo, the empty-space deselect),
// so onPointerMove only reports the transition once, exactly when the box opens.
describe('band visibility transition drives capture', () => {
  function liveHook() {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    return result
  }

  it('onPointerMove returns false while the box is still under the 4px threshold', () => {
    const result = liveHook()
    act(() => {
      expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      // A 3px nudge is below the box threshold: still an ordinary click.
      expect(result.current.onPointerMove(pointerEvent(12, 11))).toBe(false)
      expect(result.current.onPointerMove(pointerEvent(13, 12))).toBe(false)
    })
  })

  it('onPointerMove returns true exactly once, on the move that first opens the box', () => {
    const result = liveHook()
    act(() => {
      expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      expect(result.current.onPointerMove(pointerEvent(12, 11))).toBe(false)
      // Crossing 4px opens the box: this move is the one transition.
      expect(result.current.onPointerMove(pointerEvent(20, 12))).toBe(true)
    })
  })

  it('onPointerMove keeps returning false for every later move of the same box', () => {
    const result = liveHook()
    act(() => {
      expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      expect(result.current.onPointerMove(pointerEvent(20, 12))).toBe(true)
      expect(result.current.onPointerMove(pointerEvent(30, 30))).toBe(false)
      expect(result.current.onPointerMove(pointerEvent(40, 40))).toBe(false)
    })
  })

  it('a fresh gesture after endDrag reports the transition again', () => {
    const result = liveHook()
    act(() => {
      expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      expect(result.current.onPointerMove(pointerEvent(20, 12))).toBe(true)
      result.current.onPointerUp()
    })
    act(() => {
      // A second drag must report its own open transition; a latched flag
      // surviving endDrag would hide it.
      expect(result.current.onPointerDown(pointerEvent(50, 50), false)).toBe(true)
      expect(result.current.onPointerMove(pointerEvent(60, 52))).toBe(true)
    })
  })

   it('a move with no button held drops the band and reports no transition', () => {
    const result = liveHook()
    act(() => {
      expect(result.current.onPointerDown(pointerEvent(10, 10), false)).toBe(true)
      expect(result.current.onPointerMove(pointerEvent(20, 12))).toBe(true)
    })
    act(() => {
      // The release landed outside the pane; the next move carries no button.
      expect(result.current.onPointerMove(pointerEvent(60, 60, 0))).toBe(false)
    })
    expect(result.current.state.isDraggingRef.current).toBe(false)
  })
})

// Pin that the band click guard is raised ONLY for a visibly-open box, never
// for a plain or sub-threshold press. The guard is what stops a sweep's trailing
// click from toggling the sub-shape under its end cursor, but it must stay
// silent for a stationary empty click or that click's deselect is eaten.
describe('the band flag and a plain click', () => {
  beforeEach(() => { takeBandClickConsumed() })

  it('a stationary press does not raise the band click guard', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    act(() => {
      result.current.onPointerDown(pointerEvent(10, 10), false)
      result.current.onPointerUp()
    })
    expect(takeBandClickConsumed()).toBe(false)
  })

  it('a 3px press does not raise the band click guard', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    act(() => {
      result.current.onPointerDown(pointerEvent(10, 10), false)
      result.current.onPointerMove(pointerEvent(13, 10))
      result.current.onPointerUp()
    })
    expect(takeBandClickConsumed()).toBe(false)
  })

  it('an opened box still raises the band click guard', () => {
    const { gl } = glForEntityId(0)
    const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
    const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
    getLivePipeline()?.target.markClean()
    act(() => {
      result.current.onPointerDown(pointerEvent(10, 10), false)
      result.current.onPointerMove(pointerEvent(70, 70))
      result.current.onPointerUp()
    })
    expect(takeBandClickConsumed()).toBe(true)
  })
})

