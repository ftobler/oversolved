import { useCallback, useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import { collectEntitiesFromPixels } from '@/picking/collectEntitiesFromPixels'
import { rgbToId } from '@/picking/idEncoding'
import { EMPTY_ID } from '@/picking/idEncoding'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { getToolAllowedLayers } from '@/components/Viewport/idDispatch/toolAllowedLayers'

interface RubberBandRect {
  x: number
  y: number
  w: number
  h: number
  /** Left-to-right drag: entity must be fully enclosed. Right-to-left: any pixel touch. */
  mode: 'window' | 'crossing'
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
 * Left-to-right drag = window selection: only entities fully enclosed in the
 * box are selected. Right-to-left drag = crossing selection: any entity whose
 * rendered pixels touch the box is selected.
 */
export function useRubberBandSelect(
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

    const canvas = glRef.current?.domElement
    if (!canvas) return false
    const rect = canvas.getBoundingClientRect()
    startRef.current = [e.clientX - rect.left, e.clientY - rect.top]
    committedRef.current = false
    return true
  }, [glRef])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current || committedRef.current) return
    const canvas = glRef.current?.domElement
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

    const mode: 'window' | 'crossing' = cx >= startRef.current[0] ? 'window' : 'crossing'
    setRect({ x, y, w, h, mode })
  }, [glRef])

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

    const w = pipeline.target.getWidth()
    const h = pipeline.target.getHeight()

    const canvas = glRef.current?.domElement
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

    let entities: { layer: string; entityKey: string }[]

    if (currentRect.mode === 'window') {
      // Window selection: entity must have ALL pixels within the rect.
      // Read the full ID buffer and split each entity ID into "seen inside rect"
      // vs "seen outside rect". Only keep entities with no outside pixels.
      const fullBuf = new Uint8Array(w * h * 4)
      gl.readRenderTargetPixels(pipeline.target.target, 0, 0, w, h, fullBuf)

      // Rect bounds in render-target coords (row 0 = bottom, GL convention).
      const rtColMin = x0
      const rtColMax = x0 + rw
      const rtRowMin = h - y0 - rh
      const rtRowMax = h - y0

      const inRectIds = new Set<number>()
      const outsideRectIds = new Set<number>()

      for (let row = 0; row < h; row++) {
        const rowInRect = row >= rtRowMin && row < rtRowMax
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * 4
          if (fullBuf[i + 3] === 0) continue
          const id = rgbToId(fullBuf[i], fullBuf[i + 1], fullBuf[i + 2])
          if (id === EMPTY_ID) continue
          if (rowInRect && col >= rtColMin && col < rtColMax) {
            inRectIds.add(id)
          } else {
            outsideRectIds.add(id)
          }
        }
      }

      entities = []
      for (const id of inRectIds) {
        if (outsideRectIds.has(id)) continue
        const rec = pipeline.registry.lookup(id)
        if (rec) entities.push({ layer: rec.layer, entityKey: rec.entityKey })
      }
    } else {
      // Crossing selection: any entity whose pixels touch the rect is selected.
      const buf = new Uint8Array(rw * rh * 4)
      const readY = h - y0 - rh
      gl.readRenderTargetPixels(pipeline.target.target, x0, Math.max(0, readY), rw, rh, buf)

      // Flip rows: readRenderTargetPixels returns row 0 = bottom,
      // collectEntitiesFromPixels expects row 0 = top.
      const flipped = new Uint8Array(rw * rh * 4)
      for (let row = 0; row < rh; row++) {
        const srcBase = row * rw * 4
        const dstBase = (rh - 1 - row) * rw * 4
        flipped.set(buf.subarray(srcBase, srcBase + rw * 4), dstBase)
      }

      entities = collectEntitiesFromPixels(flipped, rw, rh, pipeline.registry)
    }

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
