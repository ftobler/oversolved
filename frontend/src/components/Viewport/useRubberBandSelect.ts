import { useCallback, useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import { collectEntitiesFromPixels } from '@/picking/collectEntitiesFromPixels'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { getToolAllowedLayers } from '@/components/Viewport/idDispatch/toolAllowedLayers'

interface RubberBandRect {
  x: number
  y: number
  w: number
  h: number
}

export interface RubberBandState {
  /** True when a box drag is in progress. */
  dragging: boolean
  /** The rectangle in viewport-relative pixels (e.g. left/top relative to the canvas). */
  rect: RubberBandRect | null
}

/**
 * Hook for rubber-band (drag-box) selection on empty canvas space.
 *
 * On pointer-down in empty space (no entity hit), starts a box drag.
 * During drag it exposes the current rect so the caller can render an
 * HTML overlay. On pointer-up it reads the pixel rectangle from the
 * ID render target, collects unique entities, and commits them to
 * `normalSelection`.
 *
 * Uses the tool filter from `getToolAllowedLayers` so the active tool
 * (e.g. "select edges only") restricts which layers contribute.
 */
export function useRubberBandSelect(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  glRef: React.RefObject<THREE.WebGLRenderer | null>,
): {
  state: RubberBandState
  /** Call on the root container's onPointerDown. Returns true if the box drag consumed the event. */
  onPointerDown: (e: React.PointerEvent, idBufferHitExists: boolean) => boolean
  /** Call on the root container's onPointerMove. */
  onPointerMove: (e: React.PointerEvent) => void
  /** Call on the root container's onPointerUp. Commits selection to the store. */
  onPointerUp: () => void
} {
  const [rect, setRect] = useState<RubberBandRect | null>(null)
  const dragging = !!rect

  const startRef = useRef<[number, number] | null>(null)
  const committedRef = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent, idBufferHitExists: boolean): boolean => {
    // Only left-click on empty space starts a box drag.
    if (e.button !== 0) return false
    if (idBufferHitExists) return false

    // don't start during camera rotation or context
    const state = useSketchEditorStore.getState()
    if (state.isRotating) return false

    const canvas = canvasRef.current
    if (!canvas) return false
    const rect = canvas.getBoundingClientRect()
    startRef.current = [e.clientX - rect.left, e.clientY - rect.top]
    committedRef.current = false
    return true
  }, [canvasRef])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current || committedRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const canvasRect = canvas.getBoundingClientRect()
    const cx = e.clientX - canvasRect.left
    const cy = e.clientY - canvasRect.top

    const x = Math.min(startRef.current[0], cx)
    const y = Math.min(startRef.current[1], cy)
    const w = Math.abs(cx - startRef.current[0])
    const h = Math.abs(cy - startRef.current[1])

    // Don't show a box until the user has dragged at least 4px.
    if (w < 4 && h < 4) return
    setRect({ x, y, w, h })
  }, [canvasRef])

  const onPointerUp = useCallback(() => {
    if (!startRef.current || committedRef.current) return
    committedRef.current = true

    const currentRect = rect
    if (!currentRect || (currentRect.w < 4 && currentRect.h < 4)) {
      startRef.current = null
      setRect(null)
      return
    }

    const pipeline = getLivePipeline()
    const gl = glRef.current
    if (!pipeline || !gl) {
      startRef.current = null
      setRect(null)
      return
    }

    // Determine tool-based layer filter.
    const tool = useSketchEditorStore.getState().activeTool
    const allowed = getToolAllowedLayers(tool)

    // Read pixels from the ID target over the drag rectangle.
    const w = pipeline.target.getWidth()
    const h = pipeline.target.getHeight()

    // Canvas-coord to render-target coord: y is flipped.
    const canvas = canvasRef.current
    const canvasCssW = canvas ? canvas.clientWidth : w
    const canvasCssH = canvas ? canvas.clientHeight : h
    const sx = canvasCssW > 0 ? w / canvasCssW : 1
    const sy = canvasCssH > 0 ? h / canvasCssH : 1
    const x0 = Math.max(0, Math.round(currentRect.x * sx))
    const y0 = Math.max(0, Math.round(currentRect.y * sy))
    const rw = Math.min(w - x0, Math.ceil(currentRect.w * sx))
    const rh = Math.min(h - y0, Math.ceil(currentRect.h * sy))
    if (rw <= 0 || rh <= 0) {
      startRef.current = null
      setRect(null)
      return
    }

    // Cap rect size to avoid OOM / GPU timeout.
    const MAX_PIXELS = 500 * 500
    let readW = rw
    let readH = rh
    if (readW * readH > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / (readW * readH))
      readW = Math.max(1, Math.floor(readW * scale))
      readH = Math.max(1, Math.floor(readH * scale))
    }

    const buf = new Uint8Array(readW * readH * 4)
    // readRenderTargetPixels expects bottom-left origin.
    const readY = h - y0 - readH
    gl.readRenderTargetPixels(pipeline.target.target, x0, Math.max(0, readY), readW, readH, buf)

    // Flip rows: readRenderTargetPixels returns row 0 = bottom,
    // collectEntitiesFromPixels expects row 0 = top.
    const flipped = new Uint8Array(readW * readH * 4)
    for (let row = 0; row < readH; row++) {
      const srcRow = row
      const dstRow = readH - 1 - row
      const srcBase = srcRow * readW * 4
      const dstBase = dstRow * readW * 4
      flipped.set(buf.subarray(srcBase, srcBase + readW * 4), dstBase)
    }

    const entities = collectEntitiesFromPixels(flipped, readW, readH, pipeline.registry)

    // Apply layer filter.
    const filtered = allowed
      ? entities.filter(e => allowed.has(e.layer))
      : entities

    if (filtered.length > 0) {
      const state = useSketchEditorStore.getState()
      for (const e of filtered) {
        state.toggleNormalSelection(e.entityKey)
      }
    }

    startRef.current = null
    setRect(null)
  }, [rect, glRef])

  // Clear drag on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && startRef.current) {
        startRef.current = null
        setRect(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    state: { dragging, rect },
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
