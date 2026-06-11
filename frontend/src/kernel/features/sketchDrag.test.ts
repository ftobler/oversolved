// @vitest-environment node
//
// Tests for the WASM drag fast-path (solveSketchDrag), per feature/solver-on-drag.md.
// Skips when the Rust solver WASM is absent.
//
// Tolerance notes: the drag path uses sparse CG Levenberg-Marquardt optimised
// for ~5ms latency, not full SVD convergence. Constraints are approximately
// satisfied — not bit-exact. Tolerances reflect this.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  solveSketchDrag,
  setDragCacheForTest,
  setSketchSolver,
  resetSketchSolver,
} from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { lowerSketch } from '@/wasm-kernel/lowerSketch'
import { partDocToSketches } from '@/wasm-kernel/partDocToSketches'
import { encodeInput, decodeOutput } from '@/wasm-kernel/codec'
import type { DragCacheEntry } from './sketch'

const solveBytes = loadSolver()

function rectSketchFeature(sketchId: string, w = 10, h = 6) {
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
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedCache(feature: any): DragCacheEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { sketches } = partDocToSketches([feature as any])
  const { sketch: sketchInput } = sketches[0]
  const { input, layout } = lowerSketch(sketchInput)
  if (!solveBytes) throw new Error('seedCache: WASM solver not loaded')
  const out = decodeOutput(solveBytes(encodeInput(input)))
  const entry: DragCacheEntry = {
    sketch: sketchInput,
    layout,
    plane: null,
    feature,
    lastHardSolveParams: [...out.paramsSolved],
  }
  setDragCacheForTest(feature.id, entry)
  return entry
}

// The drag path uses REG_WEIGHT_BASE=1e-3 on all params and
// REG_WEIGHT_DRAG=5e-2 on the anchor entity — this biases toward the
// warm-start, so the dragged vertex stays near (but not exactly at) the
// cursor. Tolerances reflect this regularized behaviour.
const CURSOR_TOL = 0.2
const CONSTRAINT_TOL = 0.5

describe.skipIf(!solveBytes)('solveSketchDrag (real WASM solver)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  afterAll(() => {
    resetSketchSolver()
  })

  it('returns null when the cache is empty', () => {
    const result = solveSketchDrag('unknown', [0, 0], 'L1', 'start', [5, 0])
    expect(result).toBeNull()
  })

  it('drag-solve does not mutate the cached feature', () => {
    const feature = rectSketchFeature('noMutate')
    const entry = seedCache(feature)
    const saved = JSON.parse(JSON.stringify(entry.sketch))

    solveSketchDrag('noMutate', [...entry.lastHardSolveParams], 'bottom', 'start', [2, 0])

    // The cached SketchInput must be unchanged.
    expect(entry.sketch).toEqual(saved)
  })

  it('cursor seed keeps anchor near cursor after solve (underconstrained sketch)', () => {
    // Two lines joined by a coincident, no length/dimension constraints.
    // The free vertices can move more freely.
    const feature: Record<string, unknown> = {
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
    }
    const entry = seedCache(feature)

    // Drag L2.end from [10, 10] to [12, 9]. The vertical constraint on L2
    // keeps X aligned, but Y can move.
    const cursor: [number, number] = [10, 8]
    const result = solveSketchDrag('cursorTest', [...entry.lastHardSolveParams], 'L2', 'end', cursor)

    expect(result).not.toBeNull()
    const l2Sketch = result!.sketch.L2 as { start: [number, number]; end: [number, number] }
    // L2.end Y coordinate should be near the cursor Y (the vertical constraint
    // locks X, and the regularization biases Y toward the cursor).
    expect(Math.abs(l2Sketch.end[1] - cursor[1])).toBeLessThan(CURSOR_TOL)
  })

  it('coincident join follows the dragged vertex', () => {
    const feature = rectSketchFeature('coincidentTest')
    const entry = seedCache(feature)

    // Drag bottom.end = [10,0] to [12, 2]. bottom.end is coincident with
    // right.start (c1). After the drag solve, right.start should be close to
    // bottom.end (the coincident constraint is hard with weight=1.0).
    const cursor: [number, number] = [12, 2]
    const result = solveSketchDrag('coincidentTest', [...entry.lastHardSolveParams], 'bottom', 'end', cursor)

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
    const feature = rectSketchFeature('horizTest')
    const entry = seedCache(feature)

    const cursor: [number, number] = [3, 0.5]
    const result = solveSketchDrag('horizTest', [...entry.lastHardSolveParams], 'bottom', 'start', cursor)

    expect(result).not.toBeNull()
    const bottomSketch = result!.sketch.bottom as { start: [number, number]; end: [number, number] }
    expect(Math.abs(bottomSketch.start[1] - bottomSketch.end[1])).toBeLessThan(CONSTRAINT_TOL)
  })

  it('vertical line stays vertical during drag', () => {
    const feature = rectSketchFeature('vertTest')
    const entry = seedCache(feature)

    const cursor: [number, number] = [-0.5, 2]
    const result = solveSketchDrag('vertTest', [...entry.lastHardSolveParams], 'left', 'start', cursor)

    expect(result).not.toBeNull()
    const leftSketch = result!.sketch.left as { start: [number, number]; end: [number, number] }
    expect(Math.abs(leftSketch.start[0] - leftSketch.end[0])).toBeLessThan(CONSTRAINT_TOL)
  })

  it('length constraint is honoured during drag (softSolve could not)', () => {
    const feature = rectSketchFeature('lengthTest', 10, 6)
    const entry = seedCache(feature)

    const cursor: [number, number] = [2, 0]
    const result = solveSketchDrag('lengthTest', [...entry.lastHardSolveParams], 'bottom', 'start', cursor)

    expect(result).not.toBeNull()
    const bottomSketch = result!.sketch.bottom as { start: [number, number]; end: [number, number] }
    const dx = bottomSketch.end[0] - bottomSketch.start[0]
    const dy = bottomSketch.end[1] - bottomSketch.start[1]
    const len = Math.sqrt(dx * dx + dy * dy)
    // The length of 'bottom' should be close to 10. softSolve relaxes length
    // entirely; the WASM drag path enforces it as a hard constraint (weight=1).
    expect(Math.abs(len - 10)).toBeLessThan(0.1)
  })

  it('warm-start continuity: tiny cursor step -> tiny geometry step', () => {
    const feature = rectSketchFeature('warmTest')
    const entry = seedCache(feature)

    // Frame 1: drag bottom.start to [0.1, 0]
    const result1 = solveSketchDrag('warmTest', [...entry.lastHardSolveParams], 'bottom', 'start', [0.1, 0])
    expect(result1).not.toBeNull()

    // Frame 2: use frame 1's params as warm-start, drag to [0.2, 0]
    const result2 = solveSketchDrag('warmTest', result1!.params, 'bottom', 'start', [0.2, 0])
    expect(result2).not.toBeNull()

    const b1 = (result1!.sketch.bottom as { start: [number, number] }).start
    const b2 = (result2!.sketch.bottom as { start: [number, number] }).start
    const dist = Math.hypot(b2[0] - b1[0], b2[1] - b1[1])
    expect(dist).toBeLessThan(1.0)
  })

  it('dragAnchorId maps to the correct entity layout index', () => {
    const feature = rectSketchFeature('anchorTest')
    const entry = seedCache(feature)

    const bottomIdx = entry.layout.findIndex((l) => l.id === 'bottom')
    expect(bottomIdx).toBeGreaterThanOrEqual(0)

    // Dragging bottom.start should succeed (non-null result).
    const result = solveSketchDrag('anchorTest', [...entry.lastHardSolveParams], 'bottom', 'start', [1, 0])
    expect(result).not.toBeNull()

    // Dragging a non-existent entity returns null.
    const bad = solveSketchDrag('anchorTest', [...entry.lastHardSolveParams], 'nonexistent', 'start', [0, 0])
    expect(bad).toBeNull()
  })

  it('non-direct-param vertex (arc center) returns null when no mapping exists', () => {
    // For a circle entity, only 'center' is a direct param.
    const feature: Record<string, unknown> = {
      id: 'circleSketch', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'C1', kind: 'circle' }],
      initial: { C1: [5, 5, 3] },
      constraints: [],
    }
    seedCache(feature)

    // Dragging the center (direct param) should succeed.
    const center = solveSketchDrag('circleSketch', [5, 5, 3, 0, 0], 'C1', 'center', [6, 6])
    expect(center).not.toBeNull()

    // Dragging a non-mapped vertexKey returns null.
    const bad = solveSketchDrag('circleSketch', [5, 5, 3, 0, 0], 'C1', 'start', [6, 6])
    expect(bad).toBeNull()
  })
})
