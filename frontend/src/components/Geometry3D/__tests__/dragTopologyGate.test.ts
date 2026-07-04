// Logic tests for `topologyStale`, the single gate that keeps sketch
// topology (area fills + free curve-curve intersection points) from being
// rendered, registered for picking, or offered as snap targets while the
// geometry has moved out from under the pre-drag topology.
//
// See feature/drag-topology-staleness.md. This gate is the architecturally
// load-bearing piece of the cheap drag-staleness fix: the snap scan reads the
// SAME boolean as the renderer, so the two cannot drift -- a render-suppression
// bug can never silently leave stale `isect:` ids live for the snap scan to
// commit against.
import { describe, it, expect } from 'vitest'
import { topologyStale } from '@/components/Geometry3D/dragTopologyGate'
import type { Sketch } from '@/types/cad'

const solved = {} as Sketch
const held = {} as Sketch  // a different Sketch object identity from `solved`

describe('topologyStale', () => {
  it('is false at rest (no drag, no held preview)', () => {
    expect(topologyStale(false, null, solved)).toBe(false)
  })

  it('is true during a drag on this sketch', () => {
    expect(topologyStale(true, null, solved)).toBe(true)
  })

  it('is true during the post-drag, pre-solve window (held preview != solved)', () => {
    expect(topologyStale(false, held, solved)).toBe(true)
  })

  it('becomes false once the cold solve replaces the held preview (held === solved)', () => {
    expect(topologyStale(false, solved, solved)).toBe(false)
  })

  it('becomes false once the held preview is cleared (nextHeld = null)', () => {
    expect(topologyStale(false, null, solved)).toBe(false)
  })

  it('stays true if a drag is active AND a stale held preview also lingers', () => {
    expect(topologyStale(true, held, solved)).toBe(true)
  })

  it('does not flag stale from a null held preview even when solved is also null-ish', () => {
    // During initial mount (before first solve) `solved` may be an empty object;
    // the gate must not flap on identity quirks there as long as nothing is being dragged.
    const empty = {} as Sketch
    expect(topologyStale(false, null, empty)).toBe(false)
  })
})

describe('topologyStale -- dim_label drags are excluded at the call site', () => {
  // `dim_label` drags do NOT move geometry (Geometry3D uses `solved` as the
  // preview for them), so the area fill and inferred-contact markers must
  // stay visible while the user repositions a dimension label. The gate
  // itself only knows "isDraggingThis" -- the dim_label narrowing happens at
  // the call site (`Geometry3D/index.tsx`:
  //   `isGeometryDragging = isDraggingThis && drag?.type !== 'dim_label'`).
  // This test pins the narrowing predicate the caller must apply.
  it('a dim_label drag narrows isDraggingThis to false (geometry not moving)', () => {
    // Simulate the call-site predicate: `isDraggingThis && drag?.type !== 'dim_label'`.
    const isDraggingThis = true
    const dragType: 'vertex' | 'edge' | 'dim_label' = 'dim_label'
    const isGeometryDragging = isDraggingThis && dragType !== 'dim_label'
    // And topologyStale(no geometry drag, no held preview) is false:
    expect(topologyStale(isGeometryDragging, null, solved)).toBe(false)
  })

  it('a vertex drag narrows isDraggingThis to true (geometry moving)', () => {
    const isDraggingThis = true
    const dragType: 'vertex' | 'edge' | 'dim_label' = 'vertex'
    const isGeometryDragging = isDraggingThis && dragType !== 'dim_label'
    expect(topologyStale(isGeometryDragging, null, solved)).toBe(true)
  })

  it('an edge drag narrows isDraggingThis to true (geometry moving)', () => {
    const isDraggingThis = true
    const dragType: 'vertex' | 'edge' | 'dim_label' = 'edge'
    const isGeometryDragging = isDraggingThis && dragType !== 'dim_label'
    expect(topologyStale(isGeometryDragging, null, solved)).toBe(true)
  })
})

describe('topologyStale -- complement-monotonicity with the held/preview tracker', () => {
  // Mirrors Geometry3D/index.tsx's tracker state machine:
  //   drag start            -> preview != null, held = null       -> stale
  //   drag moves            -> preview updates, held = null       -> stale
  //   pointer-up            -> preview drops to null, tracker sets
  //                              held = last preview (nextHeld)   -> stale
  //   fresh solve arrives   -> solved identity changes, held set  -> not stale
  //   next drag on same feat -> preview != null again            -> stale
  it('tracks the tracker state machine: stale until fresh solve lands', () => {
    const preDragSolve = {} as Sketch
    const postDragSolve = {} as Sketch
    const postDragHeld = {} as Sketch

    // 1. Rest.
    expect(topologyStale(false, null, preDragSolve)).toBe(false)
    // 2. Drag engages on this sketch.
    expect(topologyStale(true, null, preDragSolve)).toBe(true)
    // 3. Pointer up: held preview shown, cold solve in flight.
    expect(topologyStale(false, postDragHeld, preDragSolve)).toBe(true)
    // 4. Fresh solve arrives: Geometry3D updates `solved` to postDragSolve;
    //    the tracker clears `held` once a fresh `solved` is observed.
    expect(topologyStale(false, null, postDragSolve)).toBe(false)
  })
})