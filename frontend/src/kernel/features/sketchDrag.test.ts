// @vitest-environment node
//
// Tests for the WASM drag fast-path (prepareDragContext + solveSketchDrag),
// per feature/solver-on-drag-rewire.md. Skips when the Rust solver WASM is
// absent.
//
// The context is built straight from the feature definition with NO prior
// in-process solveSketch call -- exactly the production topology, where the
// hard solve lives in a Web Worker and the drag path must be self-sufficient
// on the main thread. (The first implementation relied on caches populated by
// solveSketch and was silently dead in the browser; see the rewire plan.)
//
// Tolerance notes: the drag path uses sparse CG Levenberg-Marquardt optimised
// for ~5ms latency, not full SVD convergence. Constraints are approximately
// satisfied -- not bit-exact. Tolerances reflect this.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  prepareDragContext,
  solveSketchDrag,
  setSketchSolver,
  resetSketchSolver,
} from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { lowerSketch } from '@/wasm-kernel/lowerSketch'
import { partDocToSketches } from '@/wasm-kernel/partDocToSketches'
import { encodeInput, decodeOutput } from '@/wasm-kernel/codec'
import { applyMoveVertex, applyMoveEntity } from '@/utils/yamlMutations/sketch'
import type { PartDoc, PartFeature } from '@/types/cad'

const solveBytes = loadSolver()

function rectSketchFeature(sketchId: string, w = 10, h = 6): PartFeature {
  return {
    id: sketchId, kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'ch1', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'ch2', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'cv1', kind: 'vertical', target: { entity: 'right' } },
      { id: 'cv2', kind: 'vertical', target: { entity: 'left' } },
      { id: 'len1', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'len2', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  } as unknown as PartFeature
}

// The drag path uses REG_WEIGHT_BASE=1e-3 on all params and
// REG_WEIGHT_DRAG=5e-2 on the anchor entity -- this biases toward the
// warm-start, so the dragged vertex stays near (but not exactly at) the
// cursor. Tolerances reflect this regularized behaviour.
const CURSOR_TOL = 0.2
const CONSTRAINT_TOL = 0.5

describe.skipIf(!solveBytes)('prepareDragContext + solveSketchDrag (real WASM solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    // Inject the solver ONLY -- no solveSketch call ever happens in this
    // suite. The drag path must engage without any in-process hard solve.
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    resetSketchSolver()
  })

  // ── Context construction ───────────────────────────────────────────────

  it('builds the context from the feature definition alone (production topology)', () => {
    const ctx = prepareDragContext(rectSketchFeature('engage'), 'bottom', 'start')
    expect(ctx).not.toBeNull()
    // params0 is the lowered feature.initial = last hard solve.
    const bottom = ctx!.layout.find((l) => l.id === 'bottom')!
    expect(ctx!.params0.slice(bottom.offset, bottom.offset + 4)).toEqual([0, 0, 10, 0])
    // The cursor lands on bottom.start's params.
    expect(ctx!.cursorIndices).toEqual([bottom.offset, bottom.offset + 1])
    // Drag options are baked in, anchored on the dragged entity's layout index.
    expect(ctx!.input.options).toEqual({
      dragMode: true,
      dragAnchorId: ctx!.layout.indexOf(bottom),
      skipStatusPass: true,
    })
  })

  it('returns null for an unknown entity or unmapped vertex', () => {
    const feature = rectSketchFeature('nulls')
    expect(prepareDragContext(feature, 'nonexistent', 'start')).toBeNull()
    // A circle has no 'start' drag handle (only 'center' is a direct vertex).
    const circle = {
      id: 'circleSketch', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'C1', kind: 'circle' }],
      initial: { C1: [5, 5, 3] },
      constraints: [],
    } as unknown as PartFeature
    expect(prepareDragContext(circle, 'C1', 'start')).toBeNull()
    expect(prepareDragContext(circle, 'C1', 'center')).not.toBeNull()
  })

  it('returns null for a non-sketch feature instead of throwing', () => {
    const notASketch = { id: 'ext1', kind: 'extrude' } as unknown as PartFeature
    expect(prepareDragContext(notASketch, 'x', 'start')).toBeNull()
  })

  it('lowers projected entities from initial and drops unresolved ones', () => {
    const feature = {
      id: 'projSketch', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'L1', kind: 'line' },
        { id: 'P1', kind: 'point', source: 'some>ancestry>query' },
        { id: 'P2', kind: 'point', source: 'unresolved>query' },
      ],
      // P1's projection was resolved by the last hard solve; P2's was not.
      initial: { L1: [0, 0, 10, 0], P1: [3, 4] },
      constraints: [
        { id: 'c1', kind: 'coincident', a: { entity: 'L1', point: 'start' }, b: { entity: 'P2', point: 'xy' } },
      ],
    } as unknown as PartFeature

    const ctx = prepareDragContext(feature, 'L1', 'end')
    expect(ctx).not.toBeNull()
    const ids = ctx!.layout.map((l) => l.id)
    expect(ids).toContain('P1')  // source stripped, params reused from initial
    expect(ids).not.toContain('P2')  // no resolved params: dropped
    const p1 = ctx!.layout.find((l) => l.id === 'P1')!
    expect(ctx!.params0.slice(p1.offset, p1.offset + 2)).toEqual([3, 4])
  })

  it('drag-solve mutates neither the feature nor the context layout/seed', () => {
    const feature = rectSketchFeature('noMutate')
    const savedFeature = JSON.parse(JSON.stringify(feature))
    const ctx = prepareDragContext(feature, 'bottom', 'start')!
    const savedParams0 = [...ctx.params0]

    solveSketchDrag(ctx, [...ctx.params0], [2, 0])

    expect(feature).toEqual(savedFeature)
    expect(ctx.params0).toEqual(savedParams0)
  })

  // ── Solve behaviour (ported from the first implementation) ─────────────

  it('cursor seed keeps anchor near cursor after solve (underconstrained sketch)', () => {
    const feature = {
      id: 'cursorTest', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [
        { id: 'L1', kind: 'line' },
        { id: 'L2', kind: 'line' },
      ],
      initial: { L1: [0, 0, 10, 0], L2: [10, 0, 10, 10] },
      constraints: [
        { id: 'c1', kind: 'coincident', a: { entity: 'L1', point: 'end' }, b: { entity: 'L2', point: 'start' } },
        { id: 'h1', kind: 'horizontal', target: { entity: 'L1' } },
        { id: 'v1', kind: 'vertical', target: { entity: 'L2' } },
      ],
    } as unknown as PartFeature
    const ctx = prepareDragContext(feature, 'L2', 'end')!

    // Drag L2.end from [10, 10] toward [10, 8]. The vertical constraint on L2
    // keeps X aligned, but Y can move.
    const cursor: [number, number] = [10, 8]
    const result = solveSketchDrag(ctx, [...ctx.params0], cursor)

    expect(result).not.toBeNull()
    const l2Sketch = result!.sketch.L2 as { start: [number, number]; end: [number, number] }
    expect(Math.abs(l2Sketch.end[1] - cursor[1])).toBeLessThan(CURSOR_TOL)
  })

  it('coincident join follows the dragged vertex', () => {
    const ctx = prepareDragContext(rectSketchFeature('coincidentTest'), 'bottom', 'end')!

    // bottom.end is coincident with right.start (c1): after the drag solve,
    // right.start stays on bottom.end (hard constraint, weight=1.0).
    const result = solveSketchDrag(ctx, [...ctx.params0], [12, 2])

    expect(result).not.toBeNull()
    const bottomSketch = result!.sketch.bottom as { start: [number, number]; end: [number, number] }
    const rightSketch = result!.sketch.right as { start: [number, number]; end: [number, number] }
    const dist = Math.hypot(
      rightSketch.start[0] - bottomSketch.end[0],
      rightSketch.start[1] - bottomSketch.end[1],
    )
    expect(dist).toBeLessThan(CONSTRAINT_TOL)
  })

  it('horizontal line stays horizontal during drag', () => {
    const ctx = prepareDragContext(rectSketchFeature('horizTest'), 'bottom', 'start')!
    const result = solveSketchDrag(ctx, [...ctx.params0], [3, 0.5])

    expect(result).not.toBeNull()
    const bottomSketch = result!.sketch.bottom as { start: [number, number]; end: [number, number] }
    expect(Math.abs(bottomSketch.start[1] - bottomSketch.end[1])).toBeLessThan(CONSTRAINT_TOL)
  })

  it('vertical line stays vertical during drag', () => {
    const ctx = prepareDragContext(rectSketchFeature('vertTest'), 'left', 'start')!
    const result = solveSketchDrag(ctx, [...ctx.params0], [-0.5, 2])

    expect(result).not.toBeNull()
    const leftSketch = result!.sketch.left as { start: [number, number]; end: [number, number] }
    expect(Math.abs(leftSketch.start[0] - leftSketch.end[0])).toBeLessThan(CONSTRAINT_TOL)
  })

  it('length constraint is honoured during drag (pure translation could not)', () => {
    const ctx = prepareDragContext(rectSketchFeature('lengthTest', 10, 6), 'bottom', 'start')!
    const result = solveSketchDrag(ctx, [...ctx.params0], [2, 0])

    expect(result).not.toBeNull()
    const bottomSketch = result!.sketch.bottom as { start: [number, number]; end: [number, number] }
    const len = Math.hypot(
      bottomSketch.end[0] - bottomSketch.start[0],
      bottomSketch.end[1] - bottomSketch.start[1],
    )
    expect(Math.abs(len - 10)).toBeLessThan(0.1)
  })

  it('warm-start continuity: tiny cursor step -> tiny geometry step (one lowering)', () => {
    const ctx = prepareDragContext(rectSketchFeature('warmTest'), 'bottom', 'start')!

    // Both frames reuse the SAME context: lowering happened once, at
    // pointer-down; each frame only rewrites params.
    const result1 = solveSketchDrag(ctx, [...ctx.params0], [0.1, 0])
    expect(result1).not.toBeNull()
    const result2 = solveSketchDrag(ctx, result1!.params, [0.2, 0])
    expect(result2).not.toBeNull()

    const b1 = (result1!.sketch.bottom as { start: [number, number] }).start
    const b2 = (result2!.sketch.bottom as { start: [number, number] }).start
    const dist = Math.hypot(b2[0] - b1[0], b2[1] - b1[1])
    expect(dist).toBeLessThan(1.0)
  })

  it('spline control point drags via the registry mapping (was silent WASM-fallback)', () => {
    const feature = {
      id: 'splineSketch', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'S1', kind: 'spline' }],
      initial: { S1: [0, 0, 3, 5, 7, 5, 10, 0] },
      constraints: [],
    } as unknown as PartFeature
    const ctx = prepareDragContext(feature, 'S1', 'c1')!
    expect(ctx).not.toBeNull()

    const cursor: [number, number] = [4, 7]
    const result = solveSketchDrag(ctx, [...ctx.params0], cursor)

    expect(result).not.toBeNull()
    // p2 is the c1 control point in the rendered Sketch shape.
    const s1 = result!.sketch.S1 as { p2: [number, number] }
    expect(Math.hypot(s1.p2[0] - cursor[0], s1.p2[1] - cursor[1])).toBeLessThan(CURSOR_TOL)
  })

  it('arc start endpoint drags via radius/angle mapping (derived vertex)', () => {
    const feature = {
      id: 'arcSketch', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'A1', kind: 'arc' }],
      // [cx, cy, radius, angle_start, angle_end]: start at (5,0), end at (0,5).
      initial: { A1: [0, 0, 5, 0, 90] },
      constraints: [],
    } as unknown as PartFeature
    const ctx = prepareDragContext(feature, 'A1', 'start')!
    expect(ctx).not.toBeNull()
    expect(ctx.arcEndpoint).toBeTruthy()

    // Drag the start point outward to (6, 0): the radius grows to 6 and the
    // start angle stays ~0, so the start lands on the cursor.
    const cursor: [number, number] = [6, 0]
    const result = solveSketchDrag(ctx, [...ctx.params0], cursor)
    expect(result).not.toBeNull()
    const a1 = result!.sketch.A1 as { start: [number, number]; radius: number }
    expect(Math.hypot(a1.start[0] - cursor[0], a1.start[1] - cursor[1])).toBeLessThan(CURSOR_TOL)
    expect(Math.abs(a1.radius - 6)).toBeLessThan(CURSOR_TOL)
  })

  it('arc end endpoint builds a context and follows the cursor', () => {
    const feature = {
      id: 'arcEndSketch', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'A1', kind: 'arc' }],
      initial: { A1: [0, 0, 5, 0, 90] },
      constraints: [],
    } as unknown as PartFeature
    const ctx = prepareDragContext(feature, 'A1', 'end')!
    expect(ctx.arcEndpoint).toBeTruthy()

    // Drag the end point (was at (0,5)) toward (0,3): radius shrinks to 3.
    const result = solveSketchDrag(ctx, [...ctx.params0], [0, 3])
    expect(result).not.toBeNull()
    const a1 = result!.sketch.A1 as { end: [number, number] }
    expect(Math.hypot(a1.end[0] - 0, a1.end[1] - 3)).toBeLessThan(CURSOR_TOL)
  })

  // ── Edge/entity drag: whole-entity translation ─────────────────────────

  it('builds an edge drag context (vertexKey=null)', () => {
    const feature = rectSketchFeature('edgeCtx')
    const ctx = prepareDragContext(feature, 'bottom', null)
    expect(ctx).not.toBeNull()
    expect(ctx!.isEdgeDrag).toBe(true)
    // A line has two coordinate pairs: start [0,1], end [2,3].
    expect(ctx!.entityCoordPairs).toEqual([[0, 1], [2, 3]])
    expect(ctx!.entityParamOffset).toBe(ctx!.layout.find((l) => l.id === 'bottom')!.offset)
    // Drag options are baked in, anchored on the dragged entity.
    expect(ctx!.input.options.dragMode).toBe(true)
    expect(ctx!.input.options.skipStatusPass).toBe(true)
  })

  it('returns null for an entity with no coordinate pairs', () => {
    // Unknown kind has no ALL_COORD_INDICES entry.
    const feature = {
      id: 'badEdge', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'X1', kind: 'unknown' }],
      initial: { X1: [0, 0] },
      constraints: [],
    } as unknown as PartFeature
    expect(prepareDragContext(feature, 'X1', null)).toBeNull()
  })

  it('edge drag translates the entity by delta and solves', () => {
    const feature = rectSketchFeature('edgeTranslate')
    const ctx = prepareDragContext(feature, 'bottom', null)!

    // Drag bottom line by delta [5, 2]. The solver should translate it and
    // keep the rectangle shape (horizontal/vertical/length constraints).
    const delta: [number, number] = [5, 2]
    const cursor: [number, number] = [5, 2]
    const result = solveSketchDrag(ctx, ctx.params0, cursor, delta)

    expect(result).not.toBeNull()
    const bottom = result!.sketch.bottom as { start: [number, number]; end: [number, number] }
    // bottom moved from [0,0]-[10,0] to [5,2]-[15,2].
    expect(bottom.start[0]).toBeCloseTo(5, 0)
    expect(bottom.start[1]).toBeCloseTo(2, 0)
    expect(bottom.end[0]).toBeCloseTo(15, 0)
    expect(bottom.end[1]).toBeCloseTo(2, 0)

    // Rectangle integrity: other edges stayed connected (coincident corners).
    const left = result!.sketch.left as { start: [number, number]; end: [number, number] }
    const top = result!.sketch.top as { start: [number, number]; end: [number, number] }
    const right = result!.sketch.right as { start: [number, number]; end: [number, number] }

    // left.start (was [0,6]) should be coincident with top.end (was [0,6])
    // After drag: left.start ≈ [5,8] (moved by delta)
    const distTopLeft = Math.hypot(left.start[0] - top.end[0], left.start[1] - top.end[1])
    expect(distTopLeft).toBeLessThan(CONSTRAINT_TOL)
    // left.end (was [0,0]) should be coincident with bottom.start (was [0,0])
    // After drag: both at [5,2]
    const distBotLeft = Math.hypot(left.end[0] - bottom.start[0], left.end[1] - bottom.start[1])
    expect(distBotLeft).toBeLessThan(CONSTRAINT_TOL)
    // right.start (was [10,0]) should be coincident with bottom.end (was [10,0])
    // After drag: both at [15,2]
    const distBotRight = Math.hypot(right.start[0] - bottom.end[0], right.start[1] - bottom.end[1])
    expect(distBotRight).toBeLessThan(CONSTRAINT_TOL)
    // top.start (was [10,6]) should be coincident with right.end (was [10,6])
    // After drag: both at [15,8]
    const distTopRight = Math.hypot(top.start[0] - right.end[0], top.start[1] - right.end[1])
    expect(distTopRight).toBeLessThan(CONSTRAINT_TOL)

    // Horizontal constraints still hold.
    expect(Math.abs(bottom.start[1] - bottom.end[1])).toBeLessThan(CONSTRAINT_TOL)
    expect(Math.abs(top.start[1] - top.end[1])).toBeLessThan(CONSTRAINT_TOL)

    // Length constraints still honoured.
    const bottomLen = Math.hypot(bottom.end[0] - bottom.start[0], bottom.end[1] - bottom.start[1])
    expect(Math.abs(bottomLen - 10)).toBeLessThan(0.1)
    const leftLen = Math.hypot(left.end[0] - left.start[0], left.end[1] - left.start[1])
    expect(Math.abs(leftLen - 6)).toBeLessThan(0.1)
  })

  it('committing edge drag solvedGeometry keeps the hard solve in the drag basin', () => {
    const feature = rectSketchFeature('edgeCommit')
    const ctx = prepareDragContext(feature, 'bottom', null)!

    // Single drag frame: translate bottom by [5, 2].
    const delta: [number, number] = [5, 2]
    const result = solveSketchDrag(ctx, ctx.params0, delta, delta)
    expect(result).not.toBeNull()

    // Pointer-up: commit with solved geometry + delta.
    const doc = { features: [feature] } as unknown as PartDoc
    const bottom = feature.initial!.bottom
    const origBottom = [...bottom]
    applyMoveEntity(doc, 'edgeCommit', 'bottom', delta, result!.geometry)

    // The committed initial adopts the solved frame's geometry.
    expect(feature.initial!.bottom[0]).toBeCloseTo(result!.geometry.bottom[0], 3)
    // The delta is applied on top (to correct solver drift).
    const expectedStartX = origBottom[0] + delta[0]
    expect(feature.initial!.bottom[0]).toBeCloseTo(expectedStartX, 1)

    // Hard solve from committed initial stays in the drag basin.
    if (!solveBytes) throw new Error('WASM solver not loaded')
    const { sketches } = partDocToSketches([feature])
    const { input, layout } = lowerSketch(sketches[0].sketch)
    const out = decodeOutput(solveBytes(encodeInput(input)))
    const bottomLayout = layout.find((l) => l.id === 'bottom')!
    const solvedStartX = out.paramsSolved[bottomLayout.offset]
    // The solved rect should be near the dragged position, not back at [0,0].
    expect(Math.abs(solvedStartX - expectedStartX)).toBeLessThan(1.0)

    // Contrast: a naive commit without solvedGeometry snaps back.
    const naive = rectSketchFeature('naiveEdgeCommit')
    const naiveDoc = { features: [naive] } as unknown as PartDoc
    applyMoveEntity(naiveDoc, 'naiveEdgeCommit', 'bottom', delta)
    const naiveExtract = partDocToSketches([naive])
    const naiveLowered = lowerSketch(naiveExtract.sketches[0].sketch)
    const naiveOut = decodeOutput(solveBytes(encodeInput(naiveLowered.input)))
    const naiveBottomLayout = naiveLowered.layout.find((l) => l.id === 'bottom')!
    const naiveStartX = naiveOut.paramsSolved[naiveBottomLayout.offset]
    // The solvedGeometry commit lands the rect further right than the naive commit.
    expect(solvedStartX - naiveStartX).toBeGreaterThan(2)
  })

  // ── Commit: the solved frame seeds the hard solve (Part B) ─────────────

  it('committing solvedGeometry keeps the hard solve in the drag basin (no snap on release)', () => {
    // The rect is fully constrained up to translation: dragging a corner
    // translates it. Drag far from the original position over several
    // warm-started frames, like a real drag.
    const feature = rectSketchFeature('commitTest')
    const ctx = prepareDragContext(feature, 'bottom', 'end')!
    let warm = [...ctx.params0]
    let last = null as ReturnType<typeof solveSketchDrag>
    // 40 small frames from [10,0] to [20,8] -- the per-frame step is small,
    // like a real pointermove stream, so the regularized anchor tracks the
    // cursor closely and the final frame sits at the drop position.
    for (let i = 1; i <= 40; i++) {
      const cursor: [number, number] = [10 + (10 * i) / 40, (8 * i) / 40]
      last = solveSketchDrag(ctx, warm, cursor)
      expect(last).not.toBeNull()
      warm = last!.params
    }

    // Pointer-up: commit the on-screen state + the final vertex position.
    const doc = { features: [feature] } as unknown as PartDoc
    applyMoveVertex(doc, 'commitTest', 'bottom', 'end', [20, 8], last!.geometry)

    // The committed initial IS the last drag frame (rounded), vertex on top.
    const draggedBottom = last!.geometry.bottom
    expect(feature.initial!.bottom[0]).toBeCloseTo(draggedBottom[0], 3)
    expect(feature.initial!.bottom[2]).toBe(20)
    expect(feature.initial!.bottom[3]).toBe(8)

    // The commit hard solve (cold, no drag regularization) seeds from the
    // committed initial and must stay where the user dropped the geometry --
    // near x=10..20, not back at the pre-drag x=0..10.
    if (!solveBytes) throw new Error('WASM solver not loaded')
    const { sketches } = partDocToSketches([feature])
    const { input, layout } = lowerSketch(sketches[0].sketch)
    const out = decodeOutput(solveBytes(encodeInput(input)))
    const bottom = layout.find((l) => l.id === 'bottom')!
    const solvedEndX = out.paramsSolved[bottom.offset + 2]
    expect(Math.abs(solvedEndX - 20)).toBeLessThan(1.0)

    // Contrast (the bug this fixes): a naive commit -- pre-drag geometry plus
    // one teleported vertex -- re-forms the rect near its OLD position.
    const naive = rectSketchFeature('naiveCommit')
    const naiveDoc = { features: [naive] } as unknown as PartDoc
    applyMoveVertex(naiveDoc, 'naiveCommit', 'bottom', 'end', [20, 8])
    const naiveExtract = partDocToSketches([naive])
    const naiveLowered = lowerSketch(naiveExtract.sketches[0].sketch)
    const naiveOut = decodeOutput(solveBytes(encodeInput(naiveLowered.input)))
    const naiveBottom = naiveLowered.layout.find((l) => l.id === 'bottom')!
    const naiveStartX = naiveOut.paramsSolved[naiveBottom.offset]
    const committedStartX = out.paramsSolved[bottom.offset]
    // The solvedGeometry commit lands the rect's start ~10 units to the right
    // of where the naive commit re-forms it.
    expect(committedStartX - naiveStartX).toBeGreaterThan(5)
  })
})
