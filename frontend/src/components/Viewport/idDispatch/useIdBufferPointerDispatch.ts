import { useEffect, type RefObject } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import type { ResolvedHit } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dimensionLabelAdapter } from './dimensionLabelAdapter'
import { brepFaceAdapter, brepEdgeAdapter, brepVertexAdapter, clearAllHover } from './brepAdapters'
import { sketchEntityAdapter } from './sketchEntityAdapter'
import { sketchVertexAdapter } from './sketchVertexAdapter'
import { planeAdapter } from './planeAdapter'
import { originAdapter } from './originAdapter'
import { getToolAllowedLayers } from './toolAllowedLayers'
import {
  DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME,
} from '@/picking'

/**
 * Records whether the most recent left-click was consumed by the id-buffer
 * dispatcher. R3F's `onPointerMissed` fires AFTER our native click listener;
 * the Viewport reads this flag to decide whether to clear selection.
 */
let lastClickIdHit = false
let lastClickWasStale = false

function setLastClickIdHit(v: boolean): void { lastClickIdHit = v }
export function wasLastClickConsumedByIdDispatch(): boolean { return lastClickIdHit }

export function wasLastClickStaleResolve(): boolean { return lastClickWasStale }

interface DispatchParams {
  canvasRef?: RefObject<HTMLCanvasElement | null>
  glRef: RefObject<THREE.WebGLRenderer | null>
  consumedLayers: ReadonlySet<string>
}

function cursorFromEvent(e: PointerEvent | MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const xCss = e.clientX - rect.left
  const yCss = e.clientY - rect.top
  const scaleX = canvas.width > 0 && rect.width > 0 ? canvas.width / rect.width : 1
  const scaleY = canvas.height > 0 && rect.height > 0 ? canvas.height / rect.height : 1
  return { x: xCss * scaleX, y: yCss * scaleY }
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string> | null): ReadonlySet<string> {
  if (!b) return a
  const out = new Set<string>()
  for (const x of a) if (b.has(x)) out.add(x)
  return out
}

// Map layer name → hover adapter.
const hoverAdapters: Record<string, ((entityKey: string) => void) | undefined> = {
  [FACE_LAYER_NAME]: brepFaceAdapter.onHover,
  [EDGE_LAYER_NAME]: brepEdgeAdapter.onHover,
  [VERTEX_LAYER_NAME]: brepVertexAdapter.onHover,
  [SKETCH_ENTITY_LAYER_NAME]: sketchEntityAdapter.onHover,
  [SKETCH_VERTEX_LAYER_NAME]: sketchVertexAdapter.onHover,
  [SKETCH_SURFACE_LAYER_NAME]: (entityKey) => {
    useSketchEditorStore.getState().setHoveredSelectionId(entityKey)
  },
  [PLANE_LAYER_NAME]: planeAdapter.onHover,
  [ORIGIN_LAYER_NAME]: originAdapter.onHover,
  [DIMENSION_LABEL_LAYER_NAME]: undefined,  // handled separately
}

export function useIdBufferPointerDispatch({ canvasRef, glRef, consumedLayers }: DispatchParams): void {
  useEffect(() => {
    let lastHoverEntity: string | null = null
    let lastHoverLayer: string | null = null
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
      const hit = pipeline.resolveSync(gl, cursorFromEvent(e, canvas), { allowedLayers: allowed })
      if (hit === null && pipeline.isDirty()) {
        lastClickWasStale = true
      }
      return hit
    }

    const applyHoverHit = (layer: string | null, entityKey: string | null) => {
      if (layer === lastHoverLayer && entityKey === lastHoverEntity) return
      // Tear down old state (clearAllHover covers all store hover fields;
      // dim-label is handled separately via its own callback).
      if (lastHoverLayer === DIMENSION_LABEL_LAYER_NAME && lastHoverEntity !== null) {
        dimensionLabelAdapter.onOut(lastHoverEntity)
      } else if (lastHoverLayer !== null) {
        clearAllHover()
      }
      // Apply new state.  Non-dim layers already had store cleared above.
      if (layer === DIMENSION_LABEL_LAYER_NAME && entityKey !== null) {
        dimensionLabelAdapter.onOver(entityKey)
      } else if (layer !== null && entityKey !== null) {
        hoverAdapters[layer]?.(entityKey)
      }
      lastHoverLayer = layer
      lastHoverEntity = entityKey
    }

    const onPointerMove = (e: MouseEvent) => {
      const pipeline = getLivePipeline()
      const gl = glRef.current
      if (!pipeline || !gl || !attached) return
      const allowed = computeAllowed()
      if (allowed.size === 0) {
        applyHoverHit(null, null)
        return
      }
      void pipeline
        .resolveAsync(gl, cursorFromEvent(e, attached), { allowedLayers: allowed })
        .then(hit => {
          applyHoverHit(hit?.layer ?? null, hit?.entityKey ?? null)
        })
        .catch(() => {})
    }

    const onClick = (e: MouseEvent) => {
      setLastClickIdHit(false)
      lastClickWasStale = false
      if (e.button !== 0 || !attached) return
      const hit = resolveSync(e, attached)
      if (!hit) return
      if (hit.layer === DIMENSION_LABEL_LAYER_NAME) {
        dimensionLabelAdapter.onClick(hit.entityKey, e.clientX, e.clientY)
        setLastClickIdHit(true)
      } else if (hit.layer === FACE_LAYER_NAME) {
        brepFaceAdapter.onClick(hit.entityKey)
        setLastClickIdHit(true)
      } else if (hit.layer === EDGE_LAYER_NAME) {
        brepEdgeAdapter.onClick(hit.entityKey)
        setLastClickIdHit(true)
      } else if (hit.layer === VERTEX_LAYER_NAME) {
        brepVertexAdapter.onClick(hit.entityKey)
        setLastClickIdHit(true)
      } else if (hit.layer === SKETCH_ENTITY_LAYER_NAME) {
        sketchEntityAdapter.onClick(hit.entityKey, e.clientX, e.clientY)
        setLastClickIdHit(true)
      } else if (hit.layer === SKETCH_VERTEX_LAYER_NAME) {
        sketchVertexAdapter.onClick(hit.entityKey, e.clientX, e.clientY)
        setLastClickIdHit(true)
      } else if (hit.layer === PLANE_LAYER_NAME) {
        planeAdapter.onClick(hit.entityKey)
        setLastClickIdHit(true)
      } else if (hit.layer === ORIGIN_LAYER_NAME) {
        originAdapter.onClick(hit.entityKey)
        setLastClickIdHit(true)
      }
    }

    const onPointerDown = (e: MouseEvent) => {
      if (e.button !== 0 || !attached) return
      const hit = resolveSync(e, attached)
      if (!hit) return
      const tool = useSketchEditorStore.getState().activeTool
      if (hit.layer === DIMENSION_LABEL_LAYER_NAME) {
        dimensionLabelAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === SKETCH_VERTEX_LAYER_NAME && (tool === 'drag' || tool === null || tool === 'select')) {
        sketchVertexAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === SKETCH_ENTITY_LAYER_NAME && (tool === 'drag' || tool === null || tool === 'select')) {
        sketchEntityAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
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
      if (lastHoverLayer === DIMENSION_LABEL_LAYER_NAME && lastHoverEntity !== null) {
        dimensionLabelAdapter.onOut(lastHoverEntity)
      } else if (lastHoverLayer !== null) {
        clearAllHover()
      }
      lastHoverLayer = null
      lastHoverEntity = null
    }
  }, [canvasRef, glRef, consumedLayers])
}
