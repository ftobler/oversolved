import { useCallback, useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import { collectEntitiesFromPixels } from '@/picking/collectEntitiesFromPixels'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { getToolAllowedLayers } from '@/registry/toolPickConfig'
import { SWALLOW_ONLY_PICK_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'

interface RubberBandRect {
  x: number
  y: number
  w: number
  h: number
}

export interface RubberBandState {
  // True when a box drag is in progress.
  dragging: boolean
  // The rectangle in viewport-relative pixels (e.g. left/top relative to the canvas).
  rect: RubberBandRect | null
  /** Ref-backed flag, true while a rubberband drag is active. Use in event handlers
   *  where React state may not yet be committed. */
  isDraggingRef: { readonly current: boolean }
}

/**
 * Hook for rubber-band (drag-box) selection on empty canvas space.
 *
 * A box selects by crossing: every entity whose rendered pixels touch the box
 * is collected. The box is query-only, never per-primitive, so the resulting
 * selection highlights every sibling sharing a collected query. A fresh box
 * REPLACES the current selection (Option A decision, 2026-08-05): the boxed
 * set is the whole selection, with no additive-with-Shift modifier.
 */
export function useRubberBandSelect(
  glRef: React.RefObject<THREE.WebGLRenderer | null>,
  consumedLayers: ReadonlySet<string>,
): {
  state: RubberBandState
  // Call on the root container's onPointerDown. Returns true if the box drag consumed the event.
  onPointerDown: (e: React.PointerEvent, idBufferHitExists: boolean) => boolean
  // Call on the root container's onPointerMove.
  onPointerMove: (e: React.PointerEvent) => void
  // Call on the root container's onPointerUp. Commits selection to the store.
  onPointerUp: () => void
} {
  const [rect, setRect] = useState<RubberBandRect | null>(null)
  const dragging = !!rect

  const startRef = useRef<[number, number] | null>(null)
  const committedRef = useRef(false)
  const rectRef = useRef<RubberBandRect | null>(null)
  const draggingRef = useRef(false)

  const onPointerDown = useCallback((e: React.PointerEvent, idBufferHitExists: boolean): boolean => {
    // Only left-click on empty space starts a box drag.
    if (e.button !== 0) return false
    if (idBufferHitExists) return false

    // don't start during camera rotation or context
    const state = useSketchEditorStore.getState()
    if (state.isRotating) return false

    const canvas = glRef.current?.domElement
    if (!canvas) return false
    const canvasRect = canvas.getBoundingClientRect()
    startRef.current = [e.clientX - canvasRect.left, e.clientY - canvasRect.top]
    committedRef.current = false
    rectRef.current = null
    draggingRef.current = true
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

    const nextRect = { x, y, w, h }
    rectRef.current = nextRect
    setRect(nextRect)
  }, [glRef])

  const onPointerUp = useCallback(() => {
    if (!startRef.current || committedRef.current) return

    const currentRect = rectRef.current
    if (!currentRect || (currentRect.w < 4 && currentRect.h < 4)) {
      startRef.current = null
      rectRef.current = null
      draggingRef.current = false
      setRect(null)
      return
    }

    const pipeline = getLivePipeline()
    const gl = glRef.current
    if (!pipeline || !gl) {
      startRef.current = null
      rectRef.current = null
      draggingRef.current = false
      setRect(null)
      return
    }

    // A dirty ID buffer holds pixels from before the last edit/undo, so a
    // commit would select entities that may no longer exist (or miss ones
    // that now do). Mirror the click path's resolvePickAtEvent guard: treat
    // dirty as a transient transition -- close the box, keep the current
    // selection, wait for the next drag.
    if (pipeline.isDirty()) {
      startRef.current = null
      rectRef.current = null
      draggingRef.current = false
      setRect(null)
      return
    }

    committedRef.current = true

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
      // Same release discipline as every other exit: the box degenerated
      // against the buffer edge (browser zoom under 100%), but the drag is
      // over and a stuck flag would suppress empty-space deselects.
      startRef.current = null
      rectRef.current = null
      draggingRef.current = false
      setRect(null)
      return
    }

    // Crossing selection: any entity whose pixels touch the rect is selected.
    // (The former window mode is dead: a box is crossing in every direction.)
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

    const entities = collectEntitiesFromPixels(flipped, rw, rh, pipeline.registry)

    // Commit only layers in the editor's consumed set, and only layers the
    // dispatcher would toggle into normalSelection on a click: feature handles
    // and dimension labels are swallow-only (the dispatcher consumes them
    // without selecting, useIdBufferPointerDispatch's click routing), so a
    // sweep over a handle or label pixel must never leak a fhandle:/dim: key
    // into normalSelection. The tool's allowedLayers filter applies on top.
    const filtered = entities.filter(e =>
      consumedLayers.has(e.layer)
      && !SWALLOW_ONLY_PICK_LAYERS.has(e.layer)
      && (allowed === null || allowed.has(e.layer)))

    // An empty or swallowed-only box commits nothing: replacing with the empty
    // set would wipe the selection on an accidental sweep across a feature
    // handle, so the current selection is left untouched.
    if (filtered.length > 0) {
      // A fresh box REPLACES the current selection with the boxed set. The box
      // resolves entities without pickKeys, so the set is query-only: every
      // sibling sharing a collected query highlights (the documented grouping).
      const keys = filtered.map(e => e.entityKey)
      useSketchEditorStore.getState().setNormalSelection(new Set(keys))
    }

    startRef.current = null
    rectRef.current = null
    draggingRef.current = false
    setRect(null)
  }, [glRef, consumedLayers])

  // Clear drag on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && startRef.current) {
        startRef.current = null
        rectRef.current = null
        draggingRef.current = false
        setRect(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    state: { dragging, rect, isDraggingRef: draggingRef },
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
