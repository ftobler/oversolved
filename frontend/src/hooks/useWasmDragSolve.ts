/**
 * useWasmDragSolve -- run the WASM drag fast-path on every rAF tick during a
 * pointer-down vertex or entity (edge) drag.
 *
 * Architecture per feature/solver-on-drag-rewire.md: the production hard solve
 * runs in a Web Worker, so this hook must be self-sufficient on the main
 * thread. It loads its own solver WASM instance (initSketchSolver on mount)
 * and builds the whole drag context at pointer-down from the feature
 * definition (prepareDragContext) -- `feature.initial` already carries the last
 * hard solve's geometry, so nothing is needed from the worker.
 *
 *  - Lowering happens once per drag; each frame only rewrites params.
 *  - Vertex drags: warm-start seed = previous frame's solved params
 *    (frame 0 = `initial`).
 *  - Edge/entity drags: each frame seeds from `initial` and translates the
 *    entity by the cursor delta, then solves.
 *  - Group drags: the same translation path, with one anchor per member and
 *    the cursor delta added to every member's coordinate pairs. The member
 *    list is built once at pointer-down and never changes mid-gesture.
 *  - rAF-throttled with a dirty flag: at most one WASM call per displayed
 *    frame, and none at all while the cursor has not moved.
 *  - Convergence failure / overconstrained -> hold last good preview.
 *  - Every successful frame is published to the dragSolveRegistry so the
 *    pointer-up commit can write the on-screen state into the doc.
 *  - Unmapped vertices return engaged=false; the caller shows a
 *    translation preview or the static sketch.
 */
import { useRef, useEffect, useMemo, useState } from 'react'
import type { Sketch, SketchFeature } from '@/types/cad'
import type { DragState } from '@/stores/sketchEditorStore'
import {
  initSketchSolver,
  isSketchSolverReady,
  prepareDragContext,
  solveSketchDrag,
  probeCircleDragMode,
  probeGroupDragMode,
} from '@/kernel/features/sketch'
import { setLastDragSolve, clearLastDragSolveFor } from '@/utils/geometry/dragSolveRegistry'
import type { CircleDragMode } from '@/kernel/features/circleDragMode'
import type { ProjectionMemberEntity } from '@/kernel/features/projectionMembers'

interface UseWasmDragSolveInput {
  featureId: string
  // Full feature definition; the drag context is lowered from it.
  featureDef?: SketchFeature
  // Active drag state; null means no drag in progress.
  drag: DragState | null
  // True when a drag is active on THIS feature.
  isDraggingThis: boolean
  /** Document origin (0,0,0) in this sketch's local 2D frame, so a
   *  `@builtin_origin` coincident pins to the document origin during the drag
   *  preview. [0,0] for the builtin planes; nonzero for an offset/projected
   *  face. Defaults to [0,0] (builtin-plane behaviour). */
  originLocal?: [number, number]
  /** The last solve's resolved entity kinds (the render sketch), so the preview
   *  reads a projected entity that changed kind in the params it was baked
   *  with. Absent leaves the document's stored kind in charge. */
  resolvedKinds?: Readonly<Record<string, string>>
  /** The last solve's derived face-projection members, so the preview lowers
   *  the wire and a constraint naming a member survives the drag. */
  derivedMembers?: readonly ProjectionMemberEntity[]
}

interface WasmDragSolveResult {
  // The WASM-solved preview, or null before the first frame lands.
  sketch: Sketch | null
  /** True when the WASM path owns this drag (context built + solver loaded).
    *  The caller must NOT show a fallback preview then -- a one-frame stale preview that
    *  disagrees with the first WASM frame produces a visible jump. */
  engaged: boolean
  /** The drag mode resolved at activation ('translate' | 'radius' | 'locked'),
    *  or undefined for a single vertex drag and a non-circle single edge drag
    *  (which behave as translate). A group resolves 'translate' or 'locked' from
    *  whether any member can move. Sticky for the whole gesture. */
  mode?: CircleDragMode
}

export function useWasmDragSolve(
  { featureId, featureDef, drag, isDraggingThis, originLocal, resolvedKinds, derivedMembers }: UseWasmDragSolveInput,
): WasmDragSolveResult {
  const warmStartRef = useRef<number[] | null>(null)
  const latestCursorRef = useRef<[number, number] | null>(null)
  const dirtyRef = useRef(false)
  const startWorldRef = useRef<[number, number] | null>(null)

  const [preview, setPreview] = useState<Sketch | null>(null)

  // Main-thread solver init. Idempotent and failure-tolerant (resolves null
  // when /wasm/ is not provisioned); until it lands, engaged stays false and
  // vertex drags show the static sketch (no preview for at most one rAF tick).
  useEffect(() => {
    void initSketchSolver()
  }, [])

  // ─── Build the drag context at pointer-down ───
  // A useMemo, not an effect: the engagement decision must be synchronous
  // with the render that first sees the drag, or the caller would show a
  // stale fallback for one frame. prepareDragContext is pure. The memo key
  // is the drag identity (entity + vertex), stable across pointermove updates.
  // Solver readiness is latched here per drag on purpose: if the WASM is
  // still loading at pointer-down, the WHOLE drag shows the static sketch --
  // flipping to the WASM path mid-drag would flash a disagreeing frame.
  const isVertexDragHere =
    isDraggingThis && !!drag && drag.type === 'vertex' && drag.featureId === featureId
  const isEdgeDragHere =
    isDraggingThis && !!drag && drag.type === 'edge' && drag.featureId === featureId
  const isDragHere = isVertexDragHere || isEdgeDragHere

  const dragEntityId = isDragHere && drag ? drag.entityId : null
  const dragVertexKey = isVertexDragHere && drag ? drag.vertexKey : null
  // The member list is fixed at pointer-down; the per-move drag update spreads
  // the state object, so this array keeps its identity for the whole gesture.
  // A new list would mean a new gesture (or none).
  const dragGroup = isDragHere && drag && 'group' in drag ? drag.group : undefined
  const isGroupDragHere = !!dragGroup && dragGroup.length > 1
  // Scalarised so a fresh array prop identity each render does not rebuild the
  // context mid-drag (the memo key must be stable across pointermove updates).
  const originX = originLocal?.[0] ?? 0
  const originY = originLocal?.[1] ?? 0
  const ctx = useMemo(() => {
    if (!featureDef || !dragEntityId) return null
    if (!isSketchSolverReady()) return null
    // For vertex drags, pass the vertex key. For edge drags, pass null. The
    // resolved kinds come from the render sketch and are memoised per solve by
    // the caller, so this dependency stays stable across a drag's frames. A
    // group's member list is likewise fixed for the gesture.
    return prepareDragContext(featureDef, dragEntityId, dragVertexKey, [originX, originY], resolvedKinds, derivedMembers, dragGroup)
  }, [featureDef, dragEntityId, dragVertexKey, dragGroup, originX, originY, resolvedKinds, derivedMembers])

  // ─── Resolve the drag mode once per gesture ───
  // The mode is decided at activation by probing the real drag solver, then stays
  // sticky for the whole gesture: the memo is keyed on the drag identity (the same
  // key that builds ctx, which is stable across pointermove updates), so it runs
  // exactly once per gesture and can never flip mid-drag. A pinned centre read as
  // "resize" one frame and "locked" the next would be a fight, so the latch is the
  // memo stability itself. Non-circle edge drags have no size param, so the mode
  // stays undefined and the commit falls back to today's translate behaviour.
  // A group probes whether any member can move: an all-fixed or all-projected
  // group is locked, so the release commits nothing and records no undo entry.
  const dragMode = useMemo(() => {
    if (!ctx || !isDragHere) return undefined
    if (ctx.group) return probeGroupDragMode(ctx)
    if (!isEdgeDragHere || ctx.sizeIndex === undefined) return undefined
    return probeCircleDragMode(ctx)
  }, [ctx, isDragHere, isEdgeDragHere])

  // ─── Track the latest cursor and edge-drag startWorld ───
  // Mark dirty only when the cursor actually moved.
  useEffect(() => {
    if (!isDragHere || !drag) return
    const c = drag.currentWorld
    const prev = latestCursorRef.current
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) {
      latestCursorRef.current = [c[0], c[1]]
      dirtyRef.current = true
    }
    // Capture startWorld for edge and group drags (used to compute the cursor
    // delta). A group drag translates even when it was pressed on a vertex.
    if ((isEdgeDragHere || isGroupDragHere) && (drag.type === 'edge' || drag.type === 'vertex')) {
      startWorldRef.current = [drag.startWorld[0], drag.startWorld[1]]
    }
  })

  // ─── Per-drag rAF solve loop ───
  useEffect(() => {
    if (!ctx || !isDragHere) {
      // Drag ended (or never engaged): drop all per-drag state. The pointer-up
      // handler has already read the registry by the time this effect runs
      // (window pointerup fires before the store update re-renders us).
      warmStartRef.current = null
      latestCursorRef.current = null
      dirtyRef.current = false
      startWorldRef.current = null
      // Scope the clear to this sketch: the registry is a global slot and this
      // effect also runs for a foreign sketch's render/unmount, which must not
      // wipe a live drag's frames.
      clearLastDragSolveFor(featureId)
      // Reset in response to an external event (pointer-up / drag end).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the reset must apply after render, in response to an external pointer-up
      setPreview(null)
      return
    }

    warmStartRef.current = [...ctx.params0]
    dirtyRef.current = true  // always solve frame 0

    let raf = 0
    const frame = () => {
      if (dirtyRef.current && latestCursorRef.current) {
        dirtyRef.current = false

        if ((ctx.isEdgeDrag || ctx.group) && startWorldRef.current) {
          const cursor = latestCursorRef.current
          if (dragMode === 'locked') {
            // Neither the centre nor the radius can move. Solve nothing and publish
            // a mode-only entry so the pointer-up commit returns null (no mutation,
            // no undo entry). The display falls through to `solved` because no
            // preview is published.
            setLastDragSolve({ featureId, mode: 'locked' })
          } else if (dragMode === 'radius') {
            // Centre pinned: the rim drag resizes the circle. Each frame seeds
            // from params0 and sets the radius to the cursor distance from centre.
            const result = solveSketchDrag(ctx, ctx.params0, cursor, undefined, 'radius')
            if (result && result.status !== 'overconstrained') {
              setLastDragSolve({ featureId, geometry: result.geometry, mode: 'radius' })
              setPreview(result.sketch)
            }
          } else {
            // Translate (mode 'translate' or absent for non-circle edge drags):
            // compute cursor delta and pass to the solver. Each frame seeds from
            // params0 + delta (not warm-start) so the solver always starts from a
            // valid solved state.
            const delta: [number, number] = [
              cursor[0] - startWorldRef.current[0],
              cursor[1] - startWorldRef.current[1],
            ]
            const result = solveSketchDrag(ctx, ctx.params0, cursor, delta)
            if (result && result.status !== 'overconstrained') {
              setLastDragSolve({ featureId, geometry: result.geometry, mode: dragMode })
              setPreview(result.sketch)
            }
          }
        } else {
          // Vertex drag: warm-start from the previous frame's solved params.
          const ws = warmStartRef.current ?? ctx.params0
          const result = solveSketchDrag(ctx, ws, latestCursorRef.current)
          if (result && result.status !== 'overconstrained') {
            warmStartRef.current = result.params
            setLastDragSolve({ featureId, geometry: result.geometry })
            setPreview(result.sketch)
          }
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      // Also clear on unmount (feature deleted / viewport teardown mid-drag):
      // a published frame must never outlive its drag, or a later non-engaged
      // drag on the same feature would commit this drag's stale geometry.
      // Scoped to the owner so a foreign sketch's unmount cannot wipe a live
      // drag's frames.
      clearLastDragSolveFor(featureId)
    }
  }, [ctx, featureId, isDragHere, dragMode])

  return { sketch: preview, engaged: !!ctx && isDragHere, mode: dragMode }
}
