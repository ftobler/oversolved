import { useEffect, type RefObject } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import type { ResolvedHit } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dimensionLabelAdapter } from './dimensionLabelAdapter'
import { getToolAllowedLayers } from './toolAllowedLayers'
import { DIMENSION_LABEL_LAYER_NAME } from '@/picking'

/**
 * Records whether the most recent left-click was consumed by the id-buffer
 * dispatcher (e.g. hit a dimension label). R3F's `onPointerMissed` fires
 * AFTER our native click listener; the Viewport reads this flag to decide
 * whether to clear selection on a "missed" click — without it, removing
 * R3F handlers from the dim label mesh would cause every label click to
 * also clear the current selection.
 */
let lastClickIdHit = false
function setLastClickIdHit(v: boolean): void { lastClickIdHit = v }
export function wasLastClickConsumedByIdDispatch(): boolean { return lastClickIdHit }

interface DispatchParams {
  /**
   * Optional explicit ref to the R3F canvas DOM element. When omitted, the
   * dispatcher uses `glRef.current.domElement`.
   */
  canvasRef?: RefObject<HTMLCanvasElement | null>
  glRef: RefObject<THREE.WebGLRenderer | null>
  /**
   * Set of layer names the dispatcher owns. Layers outside this set are
   * filtered out before any handler is invoked, so existing R3F handlers
   * on those meshes remain the only consumer.
   */
  consumedLayers: ReadonlySet<string>
}

function cursorFromEvent(e: PointerEvent | MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string> | null): ReadonlySet<string> {
  if (!b) return a
  const out = new Set<string>()
  for (const x of a) if (b.has(x)) out.add(x)
  return out
}

/**
 * Canvas-level pointer dispatcher backed by the ID buffer.
 *
 * Parallel-installed: per-mesh R3F handlers stay live. The dispatcher only
 * routes events whose resolved layer is in `consumedLayers` AND in the
 * active tool's allow-list. Slice scope (267.2): dispatcher consumes
 * `dimensionLabel` only; dimension-label R3F handlers come off in 267.3.
 */
export function useIdBufferPointerDispatch({ canvasRef, glRef, consumedLayers }: DispatchParams): void {
  useEffect(() => {
    let lastHoverEntity: string | null = null
    let attached: HTMLCanvasElement | null = null
    let raf = 0

    const computeAllowed = (): ReadonlySet<string> => {
      const tool = useSketchEditorStore.getState().activeTool
      return intersect(consumedLayers, getToolAllowedLayers(tool))
    }

    const resolveSync = (e: PointerEvent | MouseEvent, canvas: HTMLCanvasElement): ResolvedHit | null => {
      const pipeline = getLivePipeline()
      const gl = glRef.current
      if (!pipeline || !gl) return null
      const allowed = computeAllowed()
      if (allowed.size === 0) return null
      return pipeline.resolveSync(gl, cursorFromEvent(e, canvas), { allowedLayers: allowed })
    }

    const onPointerMove = (e: MouseEvent) => {
      const pipeline = getLivePipeline()
      const gl = glRef.current
      if (!pipeline || !gl || !attached) return
      const allowed = computeAllowed()
      if (allowed.size === 0) {
        if (lastHoverEntity !== null) {
          dimensionLabelAdapter.onOut(lastHoverEntity)
          lastHoverEntity = null
        }
        return
      }
      void pipeline
        .resolveAsync(gl, cursorFromEvent(e, attached), { allowedLayers: allowed })
        .then(hit => {
          const nextKey = hit?.layer === DIMENSION_LABEL_LAYER_NAME ? hit.entityKey : null
          if (nextKey === lastHoverEntity) return
          if (lastHoverEntity !== null) dimensionLabelAdapter.onOut(lastHoverEntity)
          if (nextKey !== null) dimensionLabelAdapter.onOver(nextKey)
          lastHoverEntity = nextKey
        })
    }

    const onClick = (e: MouseEvent) => {
      setLastClickIdHit(false)
      if (e.button !== 0 || !attached) return
      const hit = resolveSync(e, attached)
      if (!hit) return
      if (hit.layer === DIMENSION_LABEL_LAYER_NAME) {
        dimensionLabelAdapter.onClick(hit.entityKey, e.clientX, e.clientY)
        setLastClickIdHit(true)
      }
    }

    const onPointerDown = (e: MouseEvent) => {
      if (e.button !== 0 || !attached) return
      const hit = resolveSync(e, attached)
      if (!hit) return
      if (hit.layer === DIMENSION_LABEL_LAYER_NAME) {
        dimensionLabelAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
      }
    }

    const attach = (c: HTMLCanvasElement) => {
      attached = c
      c.addEventListener('pointermove', onPointerMove)
      c.addEventListener('pointerdown', onPointerDown)
      c.addEventListener('click', onClick)
    }

    const initial = canvasRef?.current ?? glRef.current?.domElement ?? null
    if (initial) {
      attach(initial)
    } else {
      const tryAttach = () => {
        const c = canvasRef?.current ?? glRef.current?.domElement ?? null
        if (c) { attach(c); return }
        raf = requestAnimationFrame(tryAttach)
      }
      raf = requestAnimationFrame(tryAttach)
    }

    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (attached) {
        attached.removeEventListener('pointermove', onPointerMove)
        attached.removeEventListener('pointerdown', onPointerDown)
        attached.removeEventListener('click', onClick)
        attached = null
      }
      if (lastHoverEntity !== null) {
        dimensionLabelAdapter.onOut(lastHoverEntity)
        lastHoverEntity = null
      }
    }
  }, [canvasRef, glRef, consumedLayers])
}
