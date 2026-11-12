// @vitest-environment node
//
// The `sign` field of a directional dimension makes three different promises,
// and the mutation catalog now states all three: the axis kinds keep the
// authored side when the sign is absent, `line_distance` defaults to +1 (left
// of the line as drawn), and `angle` pins the turn. This suite pins each
// sentence against the real solver so the note cannot drift from the residual.
//
// Two practice findings are rebuilt: the Numpy run's rectangle mirrored through
// the origin by `sign: 1`, and a `line_distance` that flipped the authored side
// because no sign means +1. Real kernel, gated like the other drive suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import type { ScriptStep } from '../scriptRunner'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

function sketchOf(doc: PartDoc, id: string): SketchFeature {
  return (doc.features ?? []).find(f => f.id === id) as SketchFeature
}

const RECT_IDS = ['r1', 'r2', 'r3', 'r4']

// The rect is fully constrained by its own dimensions plus one axis dimension
// from `r1:start` to the origin per axis, so a moved corner is a real solve
// result rather than an underconstrained sketch drifting.
function rectSteps(sign?: number): ScriptStep[] {
  const axis = (kind: 'point_distance_x' | 'point_distance_y'): ScriptStep => m({
    type: 'add_constraint', featureId: 'sk1', kind,
    targets: ['vertex:sk1:r1:start', '@builtin_origin'], value: 5,
    ...(sign !== undefined ? { sign } : {}),
  })
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({
      type: 'add_rect', featureId: 'sk1', p0: [5, 5], p1: [15, 15],
      entityIds: RECT_IDS, dimensions: true,
    }),
    axis('point_distance_x'),
    axis('point_distance_y'),
  ]
}

async function solvedRect(sign?: number) {
  const result = await runHeadless({ doc: emptyDriveDoc(), steps: rectSteps(sign) })
  expect(result.ok).toBe(true)
  expect(result.features).toEqual([])
  const sketch = sketchOf(result.doc as PartDoc, 'sk1')
  return { sketch, r1: sketch.initial!.r1, r2: sketch.initial!.r2 }
}

// The line is pinned at the origin and along +X, and the point's x is pinned by
// an unsigned axis dimension, so `line_distance` alone decides the point's y.
function lineSteps(sign?: number): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 10, 0], entityId: 'l1' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [5, -3], entityId: 'p1' }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['vertex:sk1:l1:start', '@builtin_origin'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:l1'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 10 }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_x', targets: ['@builtin_origin', 'vertex:sk1:p1:xy'], value: 5 }),
    m({
      type: 'add_constraint', featureId: 'sk1', kind: 'line_distance',
      targets: ['entity:sk1:l1', 'vertex:sk1:p1:xy'], value: 3,
      ...(sign !== undefined ? { sign } : {}),
    }),
  ]
}

async function solvedLine(sign?: number) {
  const result = await runHeadless({ doc: emptyDriveDoc(), steps: lineSteps(sign) })
  expect(result.ok).toBe(true)
  expect(result.features).toEqual([])
  const sketch = sketchOf(result.doc as PartDoc, 'sk1')
  return { sketch, point: sketch.initial!.p1, line: sketch.initial!.l1 }
}

describe.skipIf(!ready)('the constraint sign note (real OCC + Rust solver)', () => {
  it('keeps the authored side of a point_distance_x/_y when no sign is given', async () => {
    const { sketch, r1, r2 } = await solvedRect()
    // The rect stays 5..15 on both axes: the unsigned `|b - a| - value` row
    // cannot tell which side the author drew. r1 is the bottom line from
    // (5,5) to (15,5), r2 the right line up to (15,15).
    expect(r1[0]).toBeCloseTo(5, 6)
    expect(r1[1]).toBeCloseTo(5, 6)
    expect(r1[2]).toBeCloseTo(15, 6)
    expect(r1[3]).toBeCloseTo(5, 6)
    expect(r2[3]).toBeCloseTo(15, 6)
    for (const c of sketch.constraints ?? []) {
      if (c.kind === 'point_distance_x' || c.kind === 'point_distance_y') expect(c.sign).toBeUndefined()
    }
  }, 120_000)

  it('mirrors the rect through the origin with sign: 1', async () => {
    const { sketch, r1, r2 } = await solvedRect(1)
    // origin.x - r1.x = 5, so the authored corner lands at -5 and the rect
    // spans -5..5: the Numpy finding, now stated by the note.
    expect(r1[0]).toBeCloseTo(-5, 6)
    expect(r1[1]).toBeCloseTo(-5, 6)
    expect(r1[2]).toBeCloseTo(5, 6)
    expect(r1[3]).toBeCloseTo(-5, 6)
    expect(r2[3]).toBeCloseTo(5, 6)
    for (const c of sketch.constraints ?? []) {
      if (c.kind === 'point_distance_x' || c.kind === 'point_distance_y') expect(c.sign).toBe(1)
    }
  }, 120_000)

  it('keeps the authored side with sign: -1', async () => {
    const { r1, r2 } = await solvedRect(-1)
    expect(r1[0]).toBeCloseTo(5, 6)
    expect(r1[1]).toBeCloseTo(5, 6)
    expect(r1[2]).toBeCloseTo(15, 6)
    expect(r1[3]).toBeCloseTo(5, 6)
    expect(r2[3]).toBeCloseTo(15, 6)
  }, 120_000)

  it('puts the point on y = +3 with no line_distance sign, the +1 default', async () => {
    const { sketch, point, line } = await solvedLine()
    expect(point[0]).toBeCloseTo(5, 6)
    expect(point[1]).toBeCloseTo(3, 6)
    // The line stayed where it was drawn (0,0) to (10,0), so the point moved to
    // its left side, the sole solution the legacy +1 default admits.
    expect(line[0]).toBeCloseTo(0, 6)
    expect(line[1]).toBeCloseTo(0, 6)
    expect(line[2]).toBeCloseTo(10, 6)
    expect(line[3]).toBeCloseTo(0, 6)
    const distance = (sketch.constraints ?? []).find(c => c.kind === 'line_distance')
    expect(distance?.sign).toBeUndefined()
  }, 120_000)

  it('keeps the point at y = -3 with an explicit line_distance sign: -1', async () => {
    const { sketch, point } = await solvedLine(-1)
    expect(point[0]).toBeCloseTo(5, 6)
    expect(point[1]).toBeCloseTo(-3, 6)
    const distance = (sketch.constraints ?? []).find(c => c.kind === 'line_distance')
    expect(distance?.sign).toBe(-1)
  }, 120_000)
})
