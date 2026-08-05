/**
 * Rubber-band select must mirror the id-buffer dispatcher's swallow semantics.
 * The dispatcher resolves featureHandle and dimensionLabel layers but never
 * toggles them into normalSelection (feature handles are a drag affordance,
 * dimension labels are edited in place). A crossing sweep over those pixels
 * must likewise commit nothing - a sweep can never leak a fhandle:/dim: key
 * into normalSelection, no matter how lax the tool's allowedLayers filter is
 * (idle select has allowedLayers === null, i.e. no filter).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { IdPipeline } from '@/picking/IdPipeline'
import { setLivePipeline } from '@/picking/IdPipelineContext'
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

// Sweep a box from (10,10) to (40,40) with idle select active, driving the hook
// with the PRODUCTION consumed set (the same PART_EDITOR_CONSUMED_LAYERS the
// Viewport builds, featureHandle and dimensionLabel included).
function sweep(entityId: number): void {
  const { gl } = glForEntityId(entityId)
  const glRef = { current: gl } as React.RefObject<THREE.WebGLRenderer | null>
  const { result } = renderHook(() => useRubberBandSelect(glRef, PART_EDITOR_CONSUMED_LAYERS))
  act(() => {
    result.current.onPointerDown(pointerEvent(10, 10), false)
    result.current.onPointerMove(pointerEvent(40, 40))
    result.current.onPointerUp()
  })
}

function selectedKeys(): string[] {
  return [...useSketchEditorStore.getState().normalSelection]
}

beforeEach(resetStore)

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
