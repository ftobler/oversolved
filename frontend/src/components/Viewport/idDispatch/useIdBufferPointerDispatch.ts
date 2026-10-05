import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type * as THREE from 'three'
import { getLivePipeline } from '@/picking'
import type { ResolvedHit } from '@/picking'
import { HoverScheduler } from '@/picking/HoverScheduler'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { dimensionLabelAdapter } from './dimensionLabelAdapter'
import { featureHandleAdapter } from './featureHandleAdapter'
import { brepFaceAdapter, brepEdgeAdapter, brepVertexAdapter, clearAllHover, setSelectionIdOnHover } from './brepAdapters'
import { sketchEntityAdapter } from './sketchEntityAdapter'
import { sketchVertexAdapter } from './sketchVertexAdapter'
import { planeAdapter } from './planeAdapter'
import { originAdapter } from './originAdapter'
import { effectiveAllowedLayers } from '@/registry/toolPickConfig'
import type { ActiveTool } from '@/types/cad'
import { findEdgeKindForQuery } from './bodyDispatchCallbacks'
import { dispatchSketchClick } from './dispatchSketchClick'
import { takeDrawToolClickConsumed } from './drawToolClickGuard'
import { takeBandClickConsumed } from './bandClickGuard'
import { missClearsNormalSelection } from '@/components/Viewport/emptyClickClear'
import {
  DIMENSION_LABEL_LAYER_NAME, FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, PART_EDITOR_PICK_LAYER_NAMES,
} from '@/picking'

/**
 * The layers the part-editor id-buffer dispatcher consumes from the pick
 * buffer: everything it routes (handles, labels, B-rep, sketch, plane, origin).
 * Built from the one canonical pick-layer list so it stays a partition of the
 * same list the tool presets exclude from (toolPickConfig.ts), not a
 * hand-kept copy. `Viewport/index.tsx` passes this to both the dispatcher and
 * the rubber-band select so the two can never disagree about what the editor
 * consumes.
 */
export const PART_EDITOR_CONSUMED_LAYERS: ReadonlySet<string> = new Set(PART_EDITOR_PICK_LAYER_NAMES)

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
// The other two halves of the shared "miss clears" predicate. The backplane
// clear path (Drawing.tsx) has no access to the Viewport's click-gesture or
// rubber-band refs, so the Viewport publishes them here at gesture end, reading
// the rubber-band flag before its own teardown so a just-finished sweep does not
// clear the selection it was building. The Canvas `onPointerMissed` path reads
// the live refs instead; both must feed the identical predicate so the two clear
// paths cannot drift.
let lastClickStationaryPrimary = false
let lastClickBandDragging = false

function setLastClickIdHit(v: boolean): void { lastClickIdHit = v }
export function wasLastClickConsumedByIdDispatch(): boolean { return lastClickIdHit }

export function wasLastClickStaleResolve(): boolean { return lastClickWasStale }

export function setLastClickStationaryPrimary(v: boolean): void { lastClickStationaryPrimary = v }
function wasLastClickStationaryPrimary(): boolean { return lastClickStationaryPrimary }

export function setLastClickBandDragging(v: boolean): void { lastClickBandDragging = v }
function wasLastClickBandDragging(): boolean { return lastClickBandDragging }

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
  return missClearsNormalSelection({
    clickConsumedByIdDispatch: wasLastClickConsumedByIdDispatch(),
    clickWasStaleResolve: wasLastClickStaleResolve(),
    bandDragging: wasLastClickBandDragging(),
    stationaryPrimaryClick: wasLastClickStationaryPrimary(),
  })
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
function isDimensionToolArmed(): boolean {
  const state = useSketchEditorStore.getState()
  return state.activeTool === 'dimension' && state.activeFeatureId !== null
}

function isBrepDimensionPick(layer: string): boolean {
  if (layer !== EDGE_LAYER_NAME && layer !== VERTEX_LAYER_NAME) return false
  return isDimensionToolArmed()
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
 * Layer names the hover router will act on: every hoverAdapters entry with a
 * defined handler, plus dimensionLabel which applyHoverHit routes through its
 * own onOver/onOut. The click router's default is "toggle into normalSelection"
 * for any unmatched layer, so a consumed layer missing here is selectable but
 * never highlighted, silently. The dev assertion below fails that fast.
 */
export const HOVER_ROUTED_LAYERS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(hoverAdapters).filter(name => hoverAdapters[name] !== undefined),
  DIMENSION_LABEL_LAYER_NAME,
])

if (import.meta.env?.DEV) {
  for (const layer of PART_EDITOR_CONSUMED_LAYERS) {
    if (!HOVER_ROUTED_LAYERS.has(layer)) {
      console.error(`[idDispatch] consumed layer '${layer}' has no hover route; it will be selectable but never highlighted`)
    }
  }
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

    // The effective allowed set is re-read on every pointermove and again on the
    // rAF flush; under a filtered tool that is a fresh Set allocation each call.
    // Cache it keyed on activeTool: consumedLayers is a stable prop (the effect
    // re-runs if it changes), so the set only turns over on a tool switch, and
    // effectiveAllowedLayers returns consumedLayers by identity under no filter
    // so idle hover still allocates nothing.
    let allowedCache: ReadonlySet<string> | null = null
    let allowedCacheTool: ActiveTool | undefined
    const computeAllowed = (): ReadonlySet<string> => {
      const tool = useSketchEditorStore.getState().activeTool
      if (allowedCache === null || tool !== allowedCacheTool) {
        allowedCacheTool = tool
        allowedCache = effectiveAllowedLayers(consumedLayers, tool)
      }
      return allowedCache
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

    // One coalescing and cancellation owner for the hover resolve, shared with
    // the assembly viewport. The resolve wrapper turns the pipeline's single
    // hit into the scheduler's hit list; onHits applies it.
    const hoverScheduler = new HoverScheduler({
      resolve: async (q) => {
        const pipeline = getLivePipeline()
        const gl = glRef.current
        if (!pipeline || !gl) return []
        const hit = await pipeline.resolveAsync(gl, q.cursor, { allowedLayers: q.allowed })
        return hit ? [hit] : []
      },
      onHits: (hits) => {
        // A missing hit while the buffer is mid-rebuild is a transient
        // transition, not empty space: retain the current highlight instead of
        // tearing it down. This is the hover twin of the click path's
        // lastClickWasStale, and it trades a highlight briefly outliving its
        // geometry for no flicker on every solver commit. A clean-buffer miss
        // still clears.
        const pipeline = getLivePipeline()
        if (hits.length === 0 && pipeline?.isDirty()) return
        const top = hits[0]
        applyHoverHit(top?.layer ?? null, top?.entityKey ?? null, top?.pickKey)
      },
    })

    // Tear the hover down AND make sure it cannot come back. The scheduler's
    // clear bumps its epoch and cancels the queued trailing frame, so an
    // already-launched resolveAsync readback lands as a no-op; the explicit
    // applyHoverHit(null, null) tears down even when the stale guard in onHits
    // would have skipped the scheduler's empty report.
    const clearHover = () => {
      hoverScheduler.clear()
      applyHoverHit(null, null)
    }
    clearHoverRef.current = clearHover

    // The dedup cache (lastHover*) is this dispatcher's private record of what is
    // hovered, but the store's hover fields have other writers, and the active
    // tool's layer filter is applied only at resolve time. This listener keeps
    // both in step the instant the store changes, without waiting for a pointer
    // event. Re-entrancy latch: clearHover -> applyHoverHit -> clearAllHover
    // writes the store again while this listener is on the stack.
    let handlingStoreHoverChange = false
    const unsubStoreHover = useSketchEditorStore.subscribe((state, prev) => {
      if (handlingStoreHoverChange) return
      handlingStoreHoverChange = true
      try {
        // ─── L6: a keyboard tool switch changed which layers may hover ───
        // The dispatcher only re-filters on the next pointer event, so state it
        // has already produced under the old tool would otherwise outlive the
        // switch until a pixel of movement.
        if (state.activeTool !== prev.activeTool) {
          // Invalidate any in-flight resolve unconditionally, even with nothing
          // hovered yet: a readback launched under the old tool could still be
          // between resolveAsync and its .then, and landing it now would paint
          // a highlight for a layer the new tool forbids.
          hoverScheduler.invalidate()
          // clearHover() also runs the correct teardown (dim-label onOut), so
          // only call it when a highlight is actually applied and the new
          // filter rejects it.
          if (lastHoverLayer !== null) {
            const allowed = computeAllowed()
            if (allowed.size === 0 || !allowed.has(lastHoverLayer)) {
              clearHover()
              return
            }
          }
        }
        // ─── M1: another writer cleared the store hover under us ───
        // Body3D's per-body callback teardown (fires on every solve commit) and
        // Part.tsx resetTransientState both null hoveredSelectionId directly.
        // The dedup cache still names the old primitive, so the next same-pixel
        // move returns at applyHoverHit's guard and the highlight never comes
        // back. Drop the cache (no adapter call: the store is already clear) so
        // that move re-resolves and re-applies.
        // A sketch vertex rides hoveredVertexId only (sketchVertexAdapter), so
        // its external clear leaves hoveredSelectionId null throughout and is
        // invisible to the check above; watch hoveredVertexId too or the vertex
        // highlight stays cleared until the pointer leaves its reach.
        // This branch also fires during the dispatcher's own applyHoverHit
        // teardown (clearAllHover nulls the store mid-apply, and the latch is
        // not held then because that call comes from the scheduler's resolve,
        // not this listener). It is net-zero only because applyHoverHit
        // unconditionally re-assigns all three lastHover* locals after the
        // apply step; do not weaken that.
        const selectionHoverCleared = prev.hoveredSelectionId !== null && state.hoveredSelectionId === null
        const vertexHoverCleared = lastHoverLayer === SKETCH_VERTEX_LAYER_NAME
          && prev.hoveredVertexId !== null && state.hoveredVertexId === null
        if (
          (selectionHoverCleared || vertexHoverCleared)
          && lastHoverLayer !== null
          && lastHoverLayer !== DIMENSION_LABEL_LAYER_NAME
        ) {
          lastHoverEntity = null
          lastHoverLayer = null
          lastHoverPickKey = null
        }
      } finally {
        handlingStoreHoverChange = false
      }
    })

    /**
     * Hover resolves are capped at ~two per animation frame by the scheduler:
     * the first move in a frame resolves immediately, and every further move
     * until the next frame collapses into one trailing resolve at the last
     * cursor. Reading the ID buffer blocks the main thread until the GPU has
     * drained its queue, so coalescing costs at most one frame of hover latency
     * and avoids stacking those stalls on every pointer event.
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
      // A tool switch inside the frame cancels the queued resolve (the store
      // listener calls invalidate), so the trailing query always carries the
      // current allowed set rather than a stale one.
      hoverScheduler.schedule({ cursor: cursorFromEvent(e, attached), allowed })
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
      // A rubber-band release owns this click wherever it landed: the band
      // just committed (or tore down) a box selection, and resolving the
      // release pixel here would toggle whatever sub-shape sits under the
      // sweep's end cursor on top of the boxed set, or finalize pending
      // dimension picks when the sweep ended over empty space. Consumed also
      // claims the click for onPointerMissed, so the committed box survives.
      if (takeBandClickConsumed()) {
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
      // Swallow-only layers: resolved but never toggled into normalSelection.
      // A feature handle is a drag affordance, not a selectable entity:
      // consume the click so it neither toggles selection nor clears it via
      // the backplane. A dimension label routes to its adapter and the
      // verdict is honored: in the mount window between ID registration and
      // registerDimCallbacks nothing is registered, so the unhandled click
      // falls through unconsumed -- empty-space semantics (backplane /
      // onPointerMissed) apply instead of eating a click the label never saw.
      if (SWALLOW_ONLY_PICK_LAYERS.has(hit.layer)) {
        if (
          hit.layer === FEATURE_HANDLE_LAYER_NAME
          || (hit.layer === DIMENSION_LABEL_LAYER_NAME
            && dimensionLabelAdapter.onClick(hit.entityKey, e.clientX, e.clientY))
        ) {
          setLastClickIdHit(true)
        }
        return
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
      } else if (hit.layer === ORIGIN_LAYER_NAME && isDimensionToolArmed()) {
        // The origin is a legitimate dimension target (DimensionTool accepts
        // `@builtin_` point picks and resolveDimension has a two_vertices
        // path), but it resolves on the origin layer, which otherwise only
        // toggles normal selection. Route it through the sketch-click path so
        // the dimension tool records the pick. Planes stay out: a plane names
        // no point and resolveDimension has no pick for one.
        dispatchSketchClick(hit.entityKey, undefined, e.clientX, e.clientY)
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
      // A DOM overlay inside the R3F container (constraint tile, dimension
      // label) is a sibling of the canvas, not a descendant, so moving onto one
      // fires pointerleave here. The move/click listeners never see those
      // events, and without this the last canvas hover would freeze under the
      // overlay until the pointer returns to the canvas.
      c.addEventListener('pointerleave', clearHover)
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
      unsubStoreHover()
      // Also bumps hoverEpoch, so a readback launched just before unmount
      // cannot write a stale hover into the store after this hook is gone.
      clearHover()
      clearHoverRef.current = () => {}
      if (attached) {
        attached.removeEventListener('pointermove', onPointerMove)
        attached.removeEventListener('pointerdown', onPointerDown)
        attached.removeEventListener('click', onClick)
        attached.removeEventListener('dblclick', onDoubleClick)
        attached.removeEventListener('pointerleave', clearHover)
        attached = null
      }
    }
  }, [canvasRef, glRef, consumedLayers])

  return useCallback(() => { clearHoverRef.current() }, [])
}
