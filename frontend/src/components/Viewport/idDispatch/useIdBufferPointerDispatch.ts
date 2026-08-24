import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import type { ResolvedHit } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dimensionLabelAdapter } from './dimensionLabelAdapter'
import { featureHandleAdapter } from './featureHandleAdapter'
import { brepFaceAdapter, brepEdgeAdapter, brepVertexAdapter, clearAllHover, setSelectionIdOnHover } from './brepAdapters'
import { sketchEntityAdapter } from './sketchEntityAdapter'
import { sketchVertexAdapter } from './sketchVertexAdapter'
import { planeAdapter } from './planeAdapter'
import { originAdapter } from './originAdapter'
import { getToolAllowedLayers } from '@/registry/toolPickConfig'
import { findEdgeKindForQuery } from './bodyDispatchCallbacks'
import { takeDrawToolClickConsumed } from './drawToolClickGuard'
import {
  DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME,
} from '@/picking'

/**
 * The layers the part-editor id-buffer dispatcher consumes from the pick
 * buffer: everything it routes (handles, labels, B-rep, sketch, plane, origin).
 * `Viewport/index.tsx` passes this to both the dispatcher and the rubber-band
 * select so the two can never disagree about what the editor consumes.
 */
export const PART_EDITOR_CONSUMED_LAYERS: ReadonlySet<string> = new Set([
  DIMENSION_LABEL_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME,
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME,
])

/**
 * Layers the dispatcher resolves but never toggles into normalSelection:
 * feature handles are a drag affordance and dimension labels are edited in
 * place by their adapter. The click router and the rubber-band select both
 * consult this set, so neither can leak a fhandle:/dim: key into selection.
 */
export const SWALLOW_ONLY_PICK_LAYERS: ReadonlySet<string> = new Set([
  FEATURE_HANDLE_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME,
])

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

/**
 * Whether a click that fell through to the DrawPlane backplane should clear the
 * normal selection. Mirrors the Canvas `onPointerMissed` guard so the two clear
 * paths agree: sketch entities and vertices are visual-only (no R3F handlers),
 * so their clicks reach the backplane. If the id-buffer dispatcher already
 * consumed the click (it resolved an entity/vertex/etc.), clearing here would
 * wipe the just-toggled element -- and selecting a second one would wipe the
 * first, making multi-select (e.g. two vertices for a constraint) impossible.
 * A stale resolve (id buffer mid-rebuild) is a transient transition, not empty
 * space, so it must not clear either. The native click listener runs before
 * R3F's synthesized click, so both flags are fresh by the time this is read.
 */
export function shouldClearSelectionOnBackplaneClick(): boolean {
  if (wasLastClickConsumedByIdDispatch()) return false
  if (wasLastClickStaleResolve()) return false
  return true
}

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

/**
 * The one key-derivation function shared by hover and click. Both selection
 * stores are written with this so they can never disagree about identity.
 */
export function hitToSelectionKey(hit: ResolvedHit): string {
  return hit.entityKey
}

/**
 * Whether a click on `layer` should be auto-projected into the sketch being
 * dimensioned rather than toggled into the normal selection. Only meaningful
 * while the dimension tool is active inside a sketch.
 */
function isBrepDimensionPick(layer: string): boolean {
  if (layer !== EDGE_LAYER_NAME && layer !== VERTEX_LAYER_NAME) return false
  const state = useSketchEditorStore.getState()
  return state.activeTool === 'dimension' && state.activeFeatureId !== null
}

/**
 * Resolve the ID buffer synchronously at a pointer event's pixel, filtered to
 * `allowed` layers. The single resolve seam: the click-selection dispatch and
 * the project draw tool both call this, so the two can never disagree about
 * what is under the cursor. (The project tool used to trust the async hover the
 * move-handler had last written, which lags a frame and can hold a different
 * pixel's hit -- the dual path that made edge picks flaky.) A miss while the
 * buffer is mid-rebuild flags `lastClickWasStale` so callers treat it as a
 * transient transition, not empty space.
 */
export function resolvePickAtEvent(
  e: PointerEvent | MouseEvent,
  canvas: HTMLCanvasElement,
  gl: THREE.WebGLRenderer,
  allowed: ReadonlySet<string>,
): ResolvedHit | null {
  const pipeline = getLivePipeline()
  if (!pipeline || allowed.size === 0) return null
  const hit = pipeline.resolveSync(gl, cursorFromEvent(e, canvas), { allowedLayers: allowed })
  if (hit === null && pipeline.isDirty()) lastClickWasStale = true
  return hit
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string> | null): ReadonlySet<string> {
  if (!b) return a
  const out = new Set<string>()
  for (const x of a) if (b.has(x)) out.add(x)
  return out
}

// Map layer name → hover adapter. The optional second arg is the hovered
// primitive's per-primitive pick key (b-rep layers), used to isolate a single
// primitive when its query string is not unique.
const hoverAdapters: Record<string, ((entityKey: string, pickKey?: string) => void) | undefined> = {
  [FACE_LAYER_NAME]: brepFaceAdapter.onHover,
  [EDGE_LAYER_NAME]: brepEdgeAdapter.onHover,
  [VERTEX_LAYER_NAME]: brepVertexAdapter.onHover,
  [SKETCH_ENTITY_LAYER_NAME]: sketchEntityAdapter.onHover,
  [SKETCH_VERTEX_LAYER_NAME]: sketchVertexAdapter.onHover,
  [SKETCH_SURFACE_LAYER_NAME]: setSelectionIdOnHover,
  [PLANE_LAYER_NAME]: planeAdapter.onHover,
  [ORIGIN_LAYER_NAME]: originAdapter.onHover,
  [DIMENSION_LABEL_LAYER_NAME]: undefined,  // handled separately
  // Handle hover rides hoveredSelectionId: the arrow derives its highlight
  // from the store key, and a hovered handle blocks the rubber-band start.
  [FEATURE_HANDLE_LAYER_NAME]: setSelectionIdOnHover,
}

/**
 * @returns `clearHover`, a stable callback that tears down this dispatcher's
 * hover state and invalidates any in-flight GPU-readback resolve, so a caller
 * (pointer-leave) can stop a stale hit from landing a frame after the pointer
 * left. Backed by a ref because the real implementation lives inside the
 * effect below and is only assigned once attached.
 */
export function useIdBufferPointerDispatch({ canvasRef, glRef, consumedLayers }: DispatchParams): () => void {
  const clearHoverRef = useRef<() => void>(() => {})

  useEffect(() => {
    let lastHoverEntity: string | null = null
    let lastHoverLayer: string | null = null
    let lastHoverPickKey: string | null = null
    let attached: HTMLCanvasElement | null = null
    let raf = 0
    // The claimed hover frame, and the cursor waiting for it. See onPointerMove.
    // The allowed set is deliberately NOT captured here: it is re-derived when
    // the trailing frame flushes.
    let hoverFrame = 0
    let queuedHover: { cursor: { x: number; y: number } } | null = null
    // Bumped by clearHover to invalidate any resolveAsync promise already in
    // flight: unlike the AssemblyViewport hover path (which defers the whole
    // GPU readback into the rAF callback), resolveHover here fires the async
    // readback immediately on the first move of a frame, so cancelling the rAF
    // alone cannot stop an already-launched readback from landing late.
    let hoverEpoch = 0

    const computeAllowed = (): ReadonlySet<string> => {
      const tool = useSketchEditorStore.getState().activeTool
      return intersect(consumedLayers, getToolAllowedLayers(tool))
    }

    const resolveSync = (e: PointerEvent | MouseEvent, canvas: HTMLCanvasElement): ResolvedHit | null => {
      const gl = glRef.current
      if (!gl) return null
      return resolvePickAtEvent(e, canvas, gl, computeAllowed())
    }

    const applyHoverHit = (layer: string | null, entityKey: string | null, pickKey?: string) => {
      const pick = pickKey ?? null
      // Include pickKey in the dedup: two b-rep primitives can share an entityKey
      // (colliding query) while being different primitives, so a move between
      // them changes only pickKey and must still re-apply the highlight.
      if (layer === lastHoverLayer && entityKey === lastHoverEntity && pick === lastHoverPickKey) return
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
        hoverAdapters[layer]?.(entityKey, pick ?? undefined)
      }
      lastHoverLayer = layer
      lastHoverEntity = entityKey
      lastHoverPickKey = pick
    }

    const resolveHover = (cursor: { x: number; y: number }, allowed: ReadonlySet<string>) => {
      const pipeline = getLivePipeline()
      const gl = glRef.current
      if (!pipeline || !gl) return
      const epoch = hoverEpoch
      void pipeline
        .resolveAsync(gl, cursor, { allowedLayers: allowed })
        .then(hit => {
          // A clearHover (pointer-leave, unmount, tool switch to a
          // disallowed layer) since this readback launched must win: applying
          // a hit now would resurrect a hover the clear was meant to end.
          if (epoch !== hoverEpoch) return
          applyHoverHit(hit?.layer ?? null, hit?.entityKey ?? null, hit?.pickKey)
        })
        // Never silent: a swallowed apply error would kill the hover state
        // machine with no trace. The warn keeps the control flow identical.
        .catch(err => console.warn('hover apply failed', err))
    }

    // Tear the hover down AND make sure it cannot come back: cancels the
    // queued trailing-frame resolve and bumps hoverEpoch so an
    // already-launched resolveAsync readback lands as a no-op instead of
    // re-applying a hover for a cursor position that no longer applies.
    const clearHover = () => {
      hoverEpoch++
      if (hoverFrame) cancelAnimationFrame(hoverFrame)
      hoverFrame = 0
      queuedHover = null
      applyHoverHit(null, null)
    }
    clearHoverRef.current = clearHover

    /**
     * Hover resolves are capped at ~two per animation frame: the first move in a
     * frame resolves immediately, and every further move until the next frame
     * collapses into one trailing resolve at the last cursor.
     *
     * Reading the ID buffer means `readRenderTargetPixels`, which blocks the main
     * thread until the GPU has drained its queue -- on a heavy model that is the
     * better part of a frame, EACH TIME. A high-rate pointer delivers several moves
     * per frame, and resolving each one stacked those stalls until hovering alone
     * dropped the viewport below 1 fps. Coalescing them costs at most one frame of
     * hover latency and nothing else: clicks and drags resolve synchronously on
     * their own events and are untouched.
     */
    const onPointerMove = (e: MouseEvent) => {
      if (!attached) return
      const allowed = computeAllowed()
      if (allowed.size === 0) {
        // clearHover drops the queued trailing resolve AND invalidates any
        // readback already launched for the now-disallowed layer set -- either
        // one landing after this point would reapply a hover with nothing
        // left to un-set it.
        clearHover()
        return
      }
      const cursor = cursorFromEvent(e, attached)
      if (hoverFrame !== 0) {
        queuedHover = { cursor }
        return
      }
      resolveHover(cursor, allowed)
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0
        const queued = queuedHover
        queuedHover = null
        if (!queued) return
        // Re-derive the allowed set at flush time: a tool switch within the
        // frame must not replay the queue-time set, or a now-disallowed layer
        // would hold a hover for one frame with no event left to remove it.
        const flushedAllowed = computeAllowed()
        if (flushedAllowed.size === 0) {
          clearHover()
          return
        }
        resolveHover(queued.cursor, flushedAllowed)
      })
    }

    const onClick = (e: MouseEvent) => {
      setLastClickIdHit(false)
      lastClickWasStale = false
      if (e.button !== 0 || !attached) return
      // A sketch drawing tool (e.g. project) already consumed this click on
      // pointer-down and may have reset the tool to null since. Don't let the
      // click also toggle normal selection on the entity it just acted on.
      if (takeDrawToolClickConsumed()) {
        setLastClickIdHit(true)
        return
      }
      const hit = resolveSync(e, attached)
      if (!hit) {
        // Empty-space click during dimension placement -> finalise.
        // The store decides whether the current picks are enough to dispatch.
        // A stale-buffer miss (id buffer mid-rebuild) is a transient
        // transition, not empty space -- the same rule
        // shouldClearSelectionOnBackplaneClick applies -- so it must not
        // prematurely commit a dimension placement.
        const store = useSketchEditorStore.getState()
        if (!wasLastClickStaleResolve() && store.activeTool === 'dimension' && store.dimensionPicks.length > 0) {
          store.finalizeDimensionPlacement([e.clientX, e.clientY])
          setLastClickIdHit(true)
        }
        return
      }
      // Single click outcome for every selectable layer: toggle into normal
      // selection. The only exceptions are active sketch TOOLS (dimension /
      // entity / vertex drawing), which are not a parallel pick path, they
      // are the current tool acting. Pick chips are a consumer layer that
      // observes normalSelection downstream; they never branch the click.
      // Swallow-only layers: resolved and consumed, but never toggled into
      // normalSelection. A feature handle is a drag affordance, not a
      // selectable entity: consume the click so it neither toggles selection
      // nor clears it via the backplane, but dispatch nothing. A dimension
      // label routes to its own adapter instead of a selection toggle.
      if (SWALLOW_ONLY_PICK_LAYERS.has(hit.layer)) {
        if (hit.layer === DIMENSION_LABEL_LAYER_NAME) {
          dimensionLabelAdapter.onClick(hit.entityKey, e.clientX, e.clientY)
        }
      } else if (hit.layer === SKETCH_ENTITY_LAYER_NAME) {
        sketchEntityAdapter.onClick(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === SKETCH_VERTEX_LAYER_NAME) {
        sketchVertexAdapter.onClick(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === SKETCH_SURFACE_LAYER_NAME) {
        // The sketch surface has no per-primitive identity (pickKey === query),
        // so toggle the query alone like a sketch entity/vertex. Falling into
        // the B-rep branch would mint a phantom selectedPicks claim
        // {query -> {query}} for a layer that never distinguishes primitives.
        useSketchEditorStore.getState().toggleNormalSelection(hitToSelectionKey(hit))
      } else if (isBrepDimensionPick(hit.layer)) {
        // Dimensioning a body edge / vertex from inside a sketch: project it
        // into the sketch and dimension the projection. Faces are excluded --
        // a face lowers to a whole wire, which names no single dim target.
        useSketchEditorStore.getState().addBrepDimensionPick(hit.entityKey, {
          isVertexPick: hit.layer === VERTEX_LAYER_NAME,
          sourceKind: findEdgeKindForQuery(hit.entityKey) ?? null,
        })
      } else {
        // face / edge / vertex (B-rep) / plane / origin. Carry the hit's
        // per-primitive pickKey so the highlight isolates the exact primitive
        // clicked even when its query collides with a sibling's. pickKey equals
        // the query for layers with no per-primitive identity (planes, origin);
        // passing it through unchanged there is NOT a no-op, it mints a
        // redundant self-claim ({query -> {query}}) in selectedPicks the same
        // way the sketch-surface branch above explicitly avoids, so omit it
        // when it carries no extra identity.
        const key = hitToSelectionKey(hit)
        useSketchEditorStore.getState().toggleNormalSelection(key, hit.pickKey === key ? undefined : hit.pickKey)
      }
      setLastClickIdHit(true)
    }

    const onDoubleClick = (e: MouseEvent) => {
      if (e.button !== 0 || !attached) return
      const hit = resolveSync(e, attached)
      if (!hit) return
      // Only dimension labels and feature handles care about double-click
      // (opens the value-edit dialog; single-click selects so Delete can
      // target the dim).
      if (hit.layer === DIMENSION_LABEL_LAYER_NAME) {
        dimensionLabelAdapter.onDoubleClick(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === FEATURE_HANDLE_LAYER_NAME) {
        featureHandleAdapter.onDoubleClick(hit.entityKey, e.clientX, e.clientY)
      }
    }

    const onPointerDown = (e: MouseEvent) => {
      if (e.button !== 0 || !attached) return
      const hit = resolveSync(e, attached)
      if (!hit) return
      const tool = useSketchEditorStore.getState().activeTool
      if (hit.layer === FEATURE_HANDLE_LAYER_NAME) {
        featureHandleAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === DIMENSION_LABEL_LAYER_NAME) {
        dimensionLabelAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === SKETCH_VERTEX_LAYER_NAME && (tool === 'drag' || tool === null)) {
        sketchVertexAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
      } else if (hit.layer === SKETCH_ENTITY_LAYER_NAME && (tool === 'drag' || tool === null)) {
        sketchEntityAdapter.onPointerDown(hit.entityKey, e.clientX, e.clientY)
      }
    }

    const attach = (c: HTMLCanvasElement) => {
      attached = c
      c.addEventListener('pointermove', onPointerMove)
      c.addEventListener('pointerdown', onPointerDown)
      c.addEventListener('click', onClick)
      c.addEventListener('dblclick', onDoubleClick)
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
      // Also bumps hoverEpoch, so a readback launched just before unmount
      // cannot write a stale hover into the store after this hook is gone.
      clearHover()
      clearHoverRef.current = () => {}
      if (attached) {
        attached.removeEventListener('pointermove', onPointerMove)
        attached.removeEventListener('pointerdown', onPointerDown)
        attached.removeEventListener('click', onClick)
        attached.removeEventListener('dblclick', onDoubleClick)
        attached = null
      }
    }
  }, [canvasRef, glRef, consumedLayers])

  return useCallback(() => { clearHoverRef.current() }, [])
}
