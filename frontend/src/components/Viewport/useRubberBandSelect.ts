import { useCallback, useEffect, useRef, useState } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import { collectEntitiesFromPixels } from '@/picking/collectEntitiesFromPixels'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { effectiveAllowedLayers } from '@/registry/toolPickConfig'
import { SWALLOW_ONLY_PICK_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { markBandClickConsumed } from '@/components/Viewport/idDispatch/bandClickGuard'
import { planBandReads } from '@/components/Viewport/bandReadPlan'

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
  /** Ref-backed mirror of `dragging`: true only while a box is actually open,
   *  never for a press that has not passed the open threshold. Use in event
   *  handlers where React state may not yet be committed. */
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
  onPointerDown: (e: React.PointerEvent) => boolean
  // Call on the root container's onPointerMove. Returns true on the single move
  // that first opens a visible box (so the pane can take pointer capture only
  // then), false otherwise.
  onPointerMove: (e: React.PointerEvent) => boolean
  // Call on the root container's onPointerUp. Commits selection to the store.
  onPointerUp: () => void
  // Call on the root container's onPointerCancel. Drops the band without
  // committing, for gestures the browser tore away.
  onPointerCancel: () => void
} {
  const [rect, setRect] = useState<RubberBandRect | null>(null)
  const dragging = !!rect

  const startRef = useRef<[number, number] | null>(null)
  const committedRef = useRef(false)
  const rectRef = useRef<RubberBandRect | null>(null)
  const draggingRef = useRef(false)

  // The one exit every non-committing path shares: a stranded dragging flag
  // suppresses empty-space deselects and blocks later drags until Escape.
  const endDrag = useCallback(() => {
    // A visibly-open band owns its gesture's trailing click: the browser fires
    // click right after pointerup, and without this the dispatcher resolves
    // the release pixel, toggling whatever sub-shape sits under the sweep's
    // end cursor on top of the boxed selection (or finalizing pending
    // dimension picks over empty space). Raised on EVERY open-gesture
    // teardown, not only successful commits; rectRef is only ever set once a
    // box passed the 4px threshold, so a plain stationary press keeps its
    // normal click semantics. A teardown no click follows (cancel, strand)
    // leaves the flag to the guard's pointer-down cleanup.
    if (rectRef.current) markBandClickConsumed()
    startRef.current = null
    rectRef.current = null
    draggingRef.current = false
    setRect(null)
  }, [])

  // Reused readback buffer, grown to the largest chunk seen. Committing a box
  // used to allocate the full rect TWICE (read buffer plus row-flip copy);
  // one persistent scratch keeps repeated sweeps off the GC.
  const readScratchRef = useRef<Uint8Array | null>(null)
  const scratchFor = useCallback((bytes: number): Uint8Array => {
    let scratch = readScratchRef.current
    if (!scratch || scratch.length < bytes) {
      scratch = new Uint8Array(bytes)
      readScratchRef.current = scratch
    }
    return scratch
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent): boolean => {
    // Only left-click on empty space starts a box drag.
    if (e.button !== 0) return false
    // Mouse only: band-start reads the async hover state as its geometry
    // guard, and touch/pen first contact has no hover resolved yet, so a
    // finger landing on a body would open a box over geometry instead of
    // selecting it. Touch keeps tap gestures; revisit with a sync resolve.
    if (e.pointerType !== 'mouse') return false

    // don't start during camera rotation or context
    const state = useSketchEditorStore.getState()
    if (state.isRotating) return false

    const canvas = glRef.current?.domElement
    if (!canvas) return false
    const canvasRect = canvas.getBoundingClientRect()
    // The press only ARMS the band; the drag flag stays down until a box
    // actually opens. It is the ref half of `dragging`, and the Viewport
    // publishes it at pointer-up as "a sweep owns this click" for the sketch
    // backplane's empty-click deselect -- raising it here made every stationary
    // click inside a sketch look like the tail of a sweep and killed
    // deselection by clicking the background.
    startRef.current = [e.clientX - canvasRect.left, e.clientY - canvasRect.top]
    committedRef.current = false
    rectRef.current = null
    return true
  }, [glRef])

  const onPointerMove = useCallback((e: React.PointerEvent): boolean => {
    if (!startRef.current || committedRef.current) return false
    // A move with no button held means the release landed where we never saw
    // it (capture lost, pre-capture strand): drop the band instead of letting
    // the ghost resume under the free cursor.
    if (e.buttons === 0) {
      endDrag()
      return false
    }
    const canvas = glRef.current?.domElement
    if (!canvas) return false
    const canvasRect = canvas.getBoundingClientRect()
    const cx = e.clientX - canvasRect.left
    const cy = e.clientY - canvasRect.top

    const x = Math.min(startRef.current[0], cx)
    const y = Math.min(startRef.current[1], cy)
    const w = Math.abs(cx - startRef.current[0])
    const h = Math.abs(cy - startRef.current[1])

    // Don't show a box until the user has dragged at least 4px.
    if (w < 4 && h < 4) return false

    // Returns true on the one move that first opens a visible box. The pane uses
    // that edge to take pointer capture: capture is what keeps an off-pane release
    // reachable, and it is only wanted once there is a box to keep alive.
    const becameVisible = rectRef.current === null
    const nextRect = { x, y, w, h }
    rectRef.current = nextRect
    draggingRef.current = true
    setRect(nextRect)
    return becameVisible
  }, [glRef, endDrag])

  const onPointerUp = useCallback(() => {
    if (!startRef.current || committedRef.current) return

    const currentRect = rectRef.current
    if (!currentRect || (currentRect.w < 4 && currentRect.h < 4)) {
      endDrag()
      return
    }

    const pipeline = getLivePipeline()
    const gl = glRef.current
    if (!pipeline || !gl) {
      endDrag()
      return
    }

    // A dirty ID buffer holds pixels from before the last edit/undo, so a
    // commit would select entities that may no longer exist (or miss ones
    // that now do). Mirror the click path's resolvePickAtEvent guard: treat
    // dirty as a transient transition -- close the box, keep the current
    // selection, wait for the next drag.
    if (pipeline.isDirty()) {
      endDrag()
      return
    }

    committedRef.current = true

    // The editor's consumed set intersected with the active tool's filter, from
    // the one shared composition so the band and the click dispatcher cannot
    // drift.
    const tool = useSketchEditorStore.getState().activeTool
    const allowed = effectiveAllowedLayers(consumedLayers, tool)

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
      endDrag()
      return
    }

    // Crossing selection: any entity whose pixels touch the rect is selected.
    // (The former window mode is dead: a box is crossing in every direction.)
    // Chunks are planned top-down inside the rect; readRenderTargetPixels
    // wants a bottom-left origin, so each chunk converts its own. There is no
    // row flip anywhere: collection yields a set of touched entities and is
    // indifferent to orientation, which is what keeps the chunked reads
    // equivalent to the old single flipped read.
    const seen: { layer: string; entityKey: string }[] = []
    for (const chunk of planBandReads(rw, rh)) {
      const buf = scratchFor(chunk.w * chunk.h * 4)
      const top = y0 + chunk.y
      const gy = Math.max(0, Math.min(h - chunk.h, h - top - chunk.h))
      gl.readRenderTargetPixels(pipeline.target.target, x0 + chunk.x, gy, chunk.w, chunk.h, buf)
      seen.push(...collectEntitiesFromPixels(buf, chunk.w, chunk.h, pipeline.registry))
    }
    const entities = seen

    // Commit only layers in the editor's consumed set, and only layers the
    // dispatcher would toggle into normalSelection on a click: feature handles
    // and dimension labels are swallow-only (the dispatcher consumes them
    // without selecting, useIdBufferPointerDispatch's click routing), so a
    // sweep over a handle or label pixel must never leak a fhandle:/dim: key
    // into normalSelection. The tool's allowedLayers filter applies on top.
    const filtered = entities.filter(e =>
      allowed.has(e.layer)
      && !SWALLOW_ONLY_PICK_LAYERS.has(e.layer))

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

    endDrag()
  }, [glRef, consumedLayers, endDrag, scratchFor])

  // The browser tore the gesture away before any release reached us. Abandon
  // the band: committing a rect the user never released on would select
  // whatever happened to sit under the ghost box.
  const onPointerCancel = useCallback(() => {
    if (!startRef.current) return
    endDrag()
  }, [endDrag])

  // Clear drag on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && startRef.current) {
        endDrag()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [endDrag])

  return {
    state: { dragging, rect, isDraggingRef: draggingRef },
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  }
}

