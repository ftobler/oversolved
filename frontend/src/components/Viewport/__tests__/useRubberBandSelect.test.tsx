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

function pointerEvent(x: number, y: number): React.PointerEvent {
  return { clientX: x, clientY: y, button: 0 } as unknown as React.PointerEvent
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
