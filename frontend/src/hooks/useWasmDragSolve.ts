/**
 * useWasmDragSolve — run the WASM drag fast-path on every rAF tick during a
 * pointer-down drag, replacing the legacy softSolve approximation.
 *
 * Wiring per feature/solver-on-drag.md:
 *  - Warm-start seed = previous frame's solved params (cold = last hard solve).
 *  - Cursor position overwrites the dragged vertex's direct params.
 *  - rAF-throttled: at most one WASM call per frame regardless of pointermove
 *    frequency.
 *  - Convergence / overconstrained -> hold last good preview (no flicker).
 *  - Pointer-up fires the full cold-solve commit path (unchanged).
 *  - Edge drags: not supported yet by the WASM path; returns null so the
 *    caller falls back to softSolve.
 */
import { useRef, useEffect, useCallback, useState } from 'react'
import type { Sketch, Entity } from '@/types/cad'
import type { DragState } from '@/stores/sketchEditorStore'
import { solveSketchDrag, getDragCache } from '@/kernel/features/sketch'

/** Rebuild a Sketch from the hard-solve params + cached layout, for the
 *  cold frame-0 warm-start (before the first drag-tick solve). */
function hardSolveParamsToSketch(params: number[], featureId: string): Sketch | null {
  const cache = getDragCache(featureId)
  if (!cache || !cache.layout || cache.layout.length === 0) return null
  const entities: Record<string, Entity> = {}
  for (const ent of cache.layout) {
    if (ent.id === '_origin') continue
    const p = params.slice(ent.offset, ent.offset + ent.size)
    switch (ent.kind) {
      case 'line':
        entities[ent.id] = { start: [p[0], p[1]], end: [p[2], p[3]] } as Entity
        break
      case 'circle':
        entities[ent.id] = { center: [p[0], p[1]], radius: p[2] } as Entity
        break
      case 'arc': {
        const cx = p[0], cy = p[1], r = p[2], a0 = p[3], a1 = p[4]
        const a0r = a0 * Math.PI / 180, a1r = a1 * Math.PI / 180
        entities[ent.id] = {
          center: [cx, cy], radius: r,
          angle_start: a0, angle_end: a1,
          start: [cx + r * Math.cos(a0r), cy + r * Math.sin(a0r)],
          end: [cx + r * Math.cos(a1r), cy + r * Math.sin(a1r)],
        } as Entity
        break
      }
      case 'point':
        entities[ent.id] = { x: p[0], y: p[1] } as Entity
        break
      case 'ellipse':
        entities[ent.id] = { center: [p[0], p[1]], a: p[2], b: p[3], theta: p[4] } as Entity
        break
      case 'spline':
        entities[ent.id] = { p1: [p[0], p[1]], p2: [p[2], p[3]], p3: [p[4], p[5]], p4: [p[6], p[7]] } as Entity
        break
    }
  }
  return entities as Sketch
}

export interface UseWasmDragSolveInput {
  featureId: string
  /** The last hard-solved sketch (Geometry3D.solved prop). Not used directly
   *  for the WASM path but triggers a warm-start re-seed when it changes. */
  solved: Sketch
  /** Active drag state; null means no drag in progress. */
  drag: DragState | null
  /** True when a drag is active on THIS feature. */
  isDraggingThis: boolean
}

/**
 * Core hook. Manages warm-start continuity across drag frames and throttles
 * WASM solves to requestAnimationFrame.
 *
 * Returns the WASM-solved preview Sketch during vertex drags. Returns null for
 * edge/dim_label drags (caller should fall back to softSolve).
 */
export function useWasmDragSolve(
  { featureId, solved, drag, isDraggingThis }: UseWasmDragSolveInput,
): Sketch | null {
  const warmStartRef = useRef<number[] | null>(null)
  const lastPreviewRef = useRef<Sketch | null>(null)
  const rafRef = useRef<number | null>(null)
  const latestCursorRef = useRef<[number, number]>([0, 0])
  const seededRef = useRef(false)
  const dragDataRef = useRef<{ entityId: string; vertexKey: string } | null>(null)
  const onFrameRef = useRef<(() => void) | null>(null)

  const [preview, setPreview] = useState<Sketch | null>(null)

  // ── Track latest cursor from drag.currentWorld ───────────────────────
  useEffect(() => {
    if (isDraggingThis && drag && drag.type === 'vertex') {
      const d = drag
      latestCursorRef.current = d.currentWorld
    }
  })

  // ── Seed warm-start from the last hard-solve on pointer-down ──────────
  useEffect(() => {
    if (!isDraggingThis || !drag) return
    if (drag.featureId !== featureId) return
    if (drag.type !== 'vertex') return

    const d = drag
    dragDataRef.current = { entityId: d.entityId, vertexKey: d.vertexKey }

    if (!seededRef.current) {
      const cache = getDragCache(featureId)
      if (cache && cache.lastHardSolveParams && cache.lastHardSolveParams.length > 0) {
        warmStartRef.current = [...cache.lastHardSolveParams]
        seededRef.current = true
        lastPreviewRef.current = hardSolveParamsToSketch(cache.lastHardSolveParams, featureId)
      }
    }
  }, [isDraggingThis, drag, featureId])

  // ── Reset on pointer-up or feature change ────────────────────────────
  useEffect(() => {
    if (!isDraggingThis) {
      seededRef.current = false
      warmStartRef.current = null
      lastPreviewRef.current = null
      dragDataRef.current = null
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Clear the preview when dragging stops — the intent is to reset
      // state in response to an external event (pointer-up).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview(null)
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isDraggingThis])

  // Reseed warm-start when the hard solve finishes.
  useEffect(() => {
    if (isDraggingThis) return
    seededRef.current = false
    warmStartRef.current = null
    lastPreviewRef.current = null
  }, [solved, isDraggingThis])

  // ── Build the per-frame solver callback ──────────────────────────────
  // Must live in a ref (not a useCallback) so the rAF loop can schedule
  // itself without a stale-closure hazard.
  useEffect(() => {
    onFrameRef.current = () => {
      const ws = warmStartRef.current
      const dd = dragDataRef.current
      if (!ws || !dd) {
        rafRef.current = requestAnimationFrame(onFrameRef.current!)
        return
      }

      const cursor = latestCursorRef.current
      const result = solveSketchDrag(featureId, ws, dd.entityId, dd.vertexKey, cursor)

      if (result && result.status !== 'overconstrained') {
        warmStartRef.current = result.params
        lastPreviewRef.current = result.sketch
        setPreview(result.sketch)
      }

      rafRef.current = requestAnimationFrame(onFrameRef.current!)
    }
  })

  // ── Start / stop the rAF loop ────────────────────────────────────────
  const scheduleRaf = useCallback(() => {
    if (rafRef.current === null && onFrameRef.current) {
      rafRef.current = requestAnimationFrame(onFrameRef.current)
    }
  }, [])

  useEffect(() => {
    if (isDraggingThis && dragDataRef.current) {
      scheduleRaf()
    }
  }, [isDraggingThis, scheduleRaf])

  return preview
}
