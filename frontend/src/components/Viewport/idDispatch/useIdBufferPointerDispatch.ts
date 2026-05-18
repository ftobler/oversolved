import { useEffect, type RefObject } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import type { ResolvedHit } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dimensionLabelAdapter } from './dimensionLabelAdapter'
import { brepFaceAdapter, brepEdgeAdapter, brepVertexAdapter, clearBrepHover } from './brepAdapters'
import { sketchEntityAdapter, clearSketchEntityHover } from './sketchEntityAdapter'
import { sketchVertexAdapter, clearSketchVertexHover } from './sketchVertexAdapter'
import { planeAdapter, clearPlaneHover } from './planeAdapter'
import { originAdapter, clearOriginHover } from './originAdapter'
import { getToolAllowedLayers } from './toolAllowedLayers'
import {
  DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
} from '@/picking'

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
  const xCss = e.clientX - rect.left
  const yCss = e.clientY - rect.top
  // Event coords are CSS pixels; id-buffer resolves in render-target pixels.
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

/**
 * Canvas-level pointer dispatcher backed by the ID buffer.
 *
 * Parallel-installed: per-mesh R3F handlers stay live. The dispatcher only
 * routes events whose resolved layer is in `consumedLayers` AND in the
 * active tool's allow-list. Slice scope (267.2): dispatcher consumes
 * `dimensionLabel` only; dimension-label R3F handlers come off in 267.3.
 */
const BREP_LAYER_NAMES = new Set([FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME])
const SKETCH_HOVER_LAYERS = new Set([SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, PLANE_LAYER_NAME, ORIGIN_LAYER_NAME])

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
      return pipeline.resolveSync(gl, cursorFromEvent(e, canvas), { allowedLayers: allowed })
    }

    const applyHoverHit = (layer: string | null, entityKey: string | null) => {
      console.log(`[collision] hit layer="${layer}" entityKey="${entityKey}"`)
      if (layer === lastHoverLayer && entityKey === lastHoverEntity) return
      // Tear down the previous hover.
      if (lastHoverLayer === DIMENSION_LABEL_LAYER_NAME && lastHoverEntity !== null) {
        dimensionLabelAdapter.onOut(lastHoverEntity)
      } else if (lastHoverLayer !== null && BREP_LAYER_NAMES.has(lastHoverLayer)) {
        clearBrepHover()
      } else if (lastHoverLayer !== null && SKETCH_HOVER_LAYERS.has(lastHoverLayer)) {
        clearSketchEntityHover()
        clearSketchVertexHover()
        clearPlaneHover()
        clearOriginHover()
      }
      // Apply the new hover.
      if (layer === DIMENSION_LABEL_LAYER_NAME && entityKey !== null) {
        dimensionLabelAdapter.onOver(entityKey)
      } else if (layer === FACE_LAYER_NAME && entityKey !== null) {
        clearBrepHover()
        brepFaceAdapter.onHover(entityKey)
      } else if (layer === EDGE_LAYER_NAME && entityKey !== null) {
        clearBrepHover()
        brepEdgeAdapter.onHover(entityKey)
      } else if (layer === VERTEX_LAYER_NAME && entityKey !== null) {
        clearBrepHover()
        brepVertexAdapter.onHover(entityKey)
      } else if (layer === SKETCH_ENTITY_LAYER_NAME && entityKey !== null) {
        clearSketchVertexHover()
        sketchEntityAdapter.onHover(entityKey)
      } else if (layer === SKETCH_VERTEX_LAYER_NAME && entityKey !== null) {
        clearSketchEntityHover()
        sketchVertexAdapter.onHover(entityKey)
      } else if (layer === PLANE_LAYER_NAME && entityKey !== null) {
        planeAdapter.onHover(entityKey)
      } else if (layer === ORIGIN_LAYER_NAME && entityKey !== null) {
        originAdapter.onHover(entityKey)
      }
      lastHoverLayer = layer
      lastHoverEntity = entityKey
    }

    const onPointerMove = (e: MouseEvent) => {
      const pipeline = getLivePipeline()
      const gl = glRef.current
      if (!pipeline || !gl || !attached) {
        console.log('[collision] NO pipeline or gl')
        return
      }
      const allowed = computeAllowed()
      console.log(`[collision] allowedLayers=${[...allowed].join(',') || '(empty)'} layers=${pipeline.getLayers().map(l => `${l.name}[${l.scene.children.length}]`).join(',')} dirty=${pipeline.isDirty()} renders=${pipeline.getRenderCount()}`)
      if (allowed.size === 0) {
        applyHoverHit(null, null)
        return
      }
      void pipeline
        .resolveAsync(gl, cursorFromEvent(e, attached), { allowedLayers: allowed })
        .then(hit => {
          console.log(`[collision] resolve returned layer="${hit?.layer ?? null}" entityKey="${hit?.entityKey ?? null}"`)
          applyHoverHit(hit?.layer ?? null, hit?.entityKey ?? null)
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
      } else if (hit.layer === SKETCH_VERTEX_LAYER_NAME && tool === 'drag') {
        sketchVertexAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
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
      } else if (lastHoverLayer !== null && BREP_LAYER_NAMES.has(lastHoverLayer)) {
        clearBrepHover()
      } else if (lastHoverLayer !== null && SKETCH_HOVER_LAYERS.has(lastHoverLayer)) {
        clearSketchEntityHover()
        clearSketchVertexHover()
        clearPlaneHover()
        clearOriginHover()
      }
      lastHoverLayer = null
      lastHoverEntity = null
    }
  }, [canvasRef, glRef, consumedLayers])
}
