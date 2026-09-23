// Pure unit tests for the profile dump: the measurement that tells a sketch
// area apart from a profile OCC will accept. No OCC.
//
// Each case is one of the candidate causes from the fix plan, pinned
// numerically so a later fix has something to move.

import { describe, it, expect } from 'vitest'
import {
  ANCHORED_KINDS,
  describeProfile,
  formatProfileReport,
  validateSketchArea,
} from './profileDiagnostics'
import { OCC_CONFUSION, TOL_LOOP_CLOSURE, TOL_TOPOLOGY_MERGE } from './solverConstants'
import type { LoopEdge } from './profileLoops'

const square = (s: number): LoopEdge[] => [
  { kind: 'line', start: [0, 0], end: [s, 0], start_vertex: '_v0', end_vertex: '_v1' },
  { kind: 'line', start: [s, 0], end: [s, s], start_vertex: '_v1', end_vertex: '_v2' },
  { kind: 'line', start: [s, s], end: [0, s], start_vertex: '_v2', end_vertex: '_v3' },
  { kind: 'line', start: [0, s], end: [0, 0], start_vertex: '_v3', end_vertex: '_v0' },
]

function arcEdge(cx: number, cy: number, r: number, a0: number, a1: number): LoopEdge {
  const r0 = (a0 * Math.PI) / 180
  const r1 = (a1 * Math.PI) / 180
  return {
    kind: 'arc',
    center: [cx, cy],
    radius: r,
    angle_start_deg: a0,
    angle_end_deg: a1,
    ccw: true,
    start: [cx + r * Math.cos(r0), cy + r * Math.sin(r0)],
    end: [cx + r * Math.cos(r1), cy + r * Math.sin(r1)],
  }
}

/** A circle expressed the way the DCEL emits one: two 180 degree arcs. */
const circleAsTwoArcs = (cx: number, cy: number, r: number): LoopEdge[] => [
  arcEdge(cx, cy, r, 0, 180),
  arcEdge(cx, cy, r, 180, 360),
]

describe('describeProfile', () => {
  it('reports the joint gap and vertex ids for a square', () => {
    const r = describeProfile([square(10)])
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].edgeCount).toBe(4)
    expect(r.loops[0].kinds).toEqual(['line', 'line', 'line', 'line'])
    expect(r.loops[0].joints).toHaveLength(4)
    for (const j of r.loops[0].joints) expect(j.gap).toBe(0)
    expect(r.loops[0].closureGap).toBe(0)
    expect(r.worstJointGap).toBe(0)
    // Every joint carries the merged vertex id from both sides.
    expect(r.loops[0].joints.map((j) => j.aEndVertex)).toEqual(['_v1', '_v2', '_v3', '_v0'])
    expect(r.loops[0].joints.map((j) => j.bStartVertex)).toEqual(['_v1', '_v2', '_v3', '_v0'])
    expect(r.loops[0].areaCoarse).toBeCloseTo(100, 9)
    expect(r.loops[0].areaRatio).toBeCloseTo(1, 9)
    expect(r.loops[0].minChord).toBeCloseTo(10, 9)
    expect(r.loops[0].duplicateOf).toBeNull()
    expect(r.verdict).toBe('ok')
    expect(r.reasons).toEqual([])
    expect(r.groups).toEqual([{ outer: 0, holes: [] }])
  })

  it('buckets a 5e-6 joint gap between edges sharing a vertex id as merge-versus-closure', () => {
    // Strictly above TOL_LOOP_CLOSURE, strictly below TOL_TOPOLOGY_MERGE: the
    // area builder merged these into one vertex, the loop chainer will not.
    const gap = 5e-6
    expect(gap).toBeGreaterThan(TOL_LOOP_CLOSURE)
    expect(gap).toBeLessThan(TOL_TOPOLOGY_MERGE)
    const loop = square(10)
    loop[0].end = [10, gap]
    const r = describeProfile([loop])
    expect(r.verdict).toBe('suspect')
    expect(r.loops[0].joints[0].gap).toBeCloseTo(gap, 12)
    expect(r.worstJointGap).toBeCloseTo(gap, 12)
    const band = r.reasons.find((x) => x.includes('TOL_LOOP_CLOSURE'))
    expect(band).toBeDefined()
    expect(band).toContain('TOL_TOPOLOGY_MERGE')
    // The shared vertex id is the half that names the mechanism.
    expect(r.reasons.some((x) => x.includes('_v1') && x.includes('vertex id'))).toBe(true)
  })

  it('flags an arc/arc joint above OCC confusion as unsnappable', () => {
    // Both sides anchored to their own circle: snapLoopJoints cannot move
    // either, so this gap survives into makeWire.
    const gap = 5e-7
    expect(gap).toBeGreaterThan(OCC_CONFUSION)
    expect(gap).toBeLessThan(TOL_LOOP_CLOSURE)
    const loop = circleAsTwoArcs(0, 0, 5)
    loop[0].end = [-5, gap]
    expect(ANCHORED_KINDS.has('arc')).toBe(true)
    const r = describeProfile([loop])
    expect(r.loops[0].joints[0].aAnchored).toBe(true)
    expect(r.loops[0].joints[0].bAnchored).toBe(true)
    expect(r.reasons.some((x) => x.includes('unsnappable'))).toBe(true)
    expect(r.verdict).toBe('suspect')
  })

  it('reports areaRatio near 2/pi for a circle split into two 180 degree arcs', () => {
    // The containment math polygonises an arc at ONE interior point, so this
    // circle is an inscribed square: 2r^2 against the true pi*r^2.
    const r = describeProfile([circleAsTwoArcs(0, 0, 5)])
    expect(r.loops[0].areaCoarse).toBeCloseTo(2 * 25, 6)
    expect(r.loops[0].areaFine).toBeCloseTo(Math.PI * 25, 0)
    expect(r.loops[0].areaRatio).toBeCloseTo(2 / Math.PI, 2)
    expect(r.loops[0].areaRatio).toBeGreaterThan(0.63)
    expect(r.loops[0].areaRatio).toBeLessThan(0.65)
    expect(r.reasons.some((x) => x.includes('area ratio'))).toBe(true)
  })

  it('reports two identical inner loops as duplicates', () => {
    // What extracting a whole nested sketch produces today: the inner loop is
    // emitted once as its own surface's boundary and once as the ring's hole.
    const outer = square(10)
    const inner = [
      { kind: 'line', start: [2, 2], end: [4, 2] },
      { kind: 'line', start: [4, 2], end: [4, 4] },
      { kind: 'line', start: [4, 4], end: [2, 4] },
      { kind: 'line', start: [2, 4], end: [2, 2] },
    ]
    const r = describeProfile([outer, inner, inner.map((e) => ({ ...e }))])
    expect(r.loops[1].duplicateOf).toBeNull()
    expect(r.loops[2].duplicateOf).toBe(1)
    expect(r.reasons.some((x) => x.includes('duplicates loop 1'))).toBe(true)
    expect(r.verdict).toBe('suspect')
  })

  it('does not call two concentric ellipses duplicates', () => {
    // A full ellipse carries no start/end and no radius, so an endpoint-only key
    // collapses every ellipse sharing a centre. That false positive marked the
    // inner ellipse of an elliptical donut unbuildable.
    const outer: LoopEdge[] = [{ kind: 'ellipse', center: [0, 0], a: 5, b: 2.5, theta: 0 }]
    const inner: LoopEdge[] = [{ kind: 'ellipse', center: [0, 0], a: 3, b: 1.5, theta: 0 }]
    const r = describeProfile([outer, inner])
    expect(r.loops[1].duplicateOf).toBeNull()
    expect(r.verdict).toBe('ok')
  })

  it('separates two circles by radius, and still catches a real repeat', () => {
    // duplicateOf is a per-LOOP verdict, so a single-loop profile can only ever
    // report null. The question is whether two loops of the same kind are told
    // apart, and whether an actual repeat is still caught.
    const distinct = describeProfile([circleAsTwoArcs(0, 0, 5), circleAsTwoArcs(0, 0, 3)])
    expect(distinct.loops[1].duplicateOf).toBeNull()
    const repeated = describeProfile([circleAsTwoArcs(0, 0, 5), circleAsTwoArcs(0, 0, 5)])
    expect(repeated.loops[1].duplicateOf).toBe(0)
  })

  it('flags an edge whose chord is under OCC confusion as degenerate', () => {
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [10, 0] },
      { kind: 'line', start: [10, 0], end: [10, 1e-8] },  // degenerate
      { kind: 'line', start: [10, 1e-8], end: [0, 10] },
      { kind: 'line', start: [0, 10], end: [0, 0] },
    ]
    const r = describeProfile([loop])
    expect(r.loops[0].minChord).toBeCloseTo(1e-8, 12)
    expect(r.reasons.some((x) => x.includes('degenerate'))).toBe(true)
  })

  it('does not call a full circle edge degenerate for having no chord', () => {
    // An ellipse (and a full-turn arc) closes on itself by construction; its
    // zero chord is not the C10 signal.
    const ellipse: LoopEdge[] = [{ kind: 'ellipse', center: [0, 0], a: 4, b: 2, theta: 0 }]
    const r = describeProfile([ellipse])
    expect(r.loops[0].minChord).toBe(Infinity)
    expect(r.reasons.some((x) => x.includes('degenerate'))).toBe(false)
  })

  it('does not call a full-turn arc degenerate for a sub-tolerance seam', () => {
    // A 360 degree arc closes on itself by construction, so its seam endpoints
    // can disagree by a floating-point amount that still sits under
    // OCC_CONFUSION. That chord is not the C10 degenerate-edge signal; without
    // the angle check this would flag a perfectly good circle unbuildable.
    const arc: LoopEdge[] = [{
      kind: 'arc', center: [0, 0], radius: 5,
      angle_start_deg: 0, angle_end_deg: 360, ccw: true,
      start: [5, 0], end: [5, 1e-8],
    }]
    const r = describeProfile([arc])
    expect(r.loops[0].minChord).toBe(Infinity)
    expect(r.reasons.some((x) => x.includes('degenerate'))).toBe(false)
  })

  it('notes when hole nesting only holds at one arc sampling', () => {
    // A small circle tucked against the big circle's chord: the 1-sample
    // polygon (a diamond) excludes its centroid, the 64-sample one contains it.
    const outer = circleAsTwoArcs(0, 0, 10)
    const inner = circleAsTwoArcs(5.5, 5.5, 1)
    const r = describeProfile([outer, inner])
    expect(r.container[1]).toBe(-1)  // coarse: not nested
    expect(r.reasons.some((x) => x.includes('depends on the sampling'))).toBe(true)
  })
})

describe('formatProfileReport', () => {
  it('renders every loop, joint and reason as pasteable text', () => {
    const loop = square(10)
    loop[3].end = [0, 5e-3]
    const r = describeProfile([loop])
    const text = formatProfileReport(r)
    expect(text).toContain('verdict suspect')
    expect(text).toContain('closureGap')
    expect(text).toContain('5.000e-3')
    expect(text).toContain('joint 3 line->line')
    expect(text).toContain('reasons:')
    // One line per joint plus the loop header, so nothing is elided.
    expect(text.split('\n').length).toBeGreaterThan(r.loops[0].joints.length)
  })
})

describe('validateSketchArea', () => {
  it('passes a square area', () => {
    expect(validateSketchArea({ boundary: square(10) })).toEqual({ buildable: true })
  })

  it('passes a ring: outer boundary with a hole', () => {
    const holes = [[
      { kind: 'line', start: [2, 2], end: [4, 2] },
      { kind: 'line', start: [4, 2], end: [4, 4] },
      { kind: 'line', start: [4, 4], end: [2, 4] },
      { kind: 'line', start: [2, 4], end: [2, 2] },
    ]]
    expect(validateSketchArea({ boundary: square(10), holes })).toEqual({ buildable: true })
  })

  it('passes a circle expressed as two arcs', () => {
    expect(validateSketchArea({ boundary: circleAsTwoArcs(0, 0, 5) })).toEqual({ buildable: true })
  })

  it('refuses an area with no boundary', () => {
    const v = validateSketchArea({ boundary: [] })
    expect(v.buildable).toBe(false)
    expect(v.reason).toContain('no boundary')
    expect(v.reasonCode).toBe('no_boundary')
  })

  // The prose is free to be reworded; the code is what a persisted snapshot is
  // read back through, so each refusal must carry its own.
  it('stamps a distinct reason code per refusal', () => {
    const unchained = square(10)
    unchained[0].end = [10, 5e-6]
    expect(validateSketchArea({ boundary: unchained }).reasonCode).toBe('loop_not_chained')

    const degenerate: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [10, 0] },
      { kind: 'line', start: [10, 0], end: [10, 1e-9] },
      { kind: 'line', start: [10, 1e-9], end: [0, 10] },
      { kind: 'line', start: [0, 10], end: [0, 0] },
    ]
    expect(validateSketchArea({ boundary: degenerate }).reasonCode).toBe('degenerate_edge')

    const hole = [
      { kind: 'line', start: [2, 2], end: [4, 2] },
      { kind: 'line', start: [4, 2], end: [4, 4] },
      { kind: 'line', start: [4, 4], end: [2, 4] },
      { kind: 'line', start: [2, 4], end: [2, 2] },
    ]
    const doubled = validateSketchArea({ boundary: square(10), holes: [hole, hole.map((e) => ({ ...e }))] })
    expect(doubled.reasonCode).toBe('duplicate_loop')

    expect(validateSketchArea({ boundary: square(10) }).reasonCode).toBeUndefined()
  })

  it('refuses an area whose joint sits above TOL_LOOP_CLOSURE, naming the band', () => {
    // The exact band the bug is about: the area builder merged it at 1e-5, the
    // loop chainer will not join it at 1e-6, so the profile never reaches OCC.
    const loop = square(10)
    loop[0].end = [10, 5e-6]
    const v = validateSketchArea({ boundary: loop })
    expect(v.buildable).toBe(false)
    expect(v.reason).toContain('TOL_LOOP_CLOSURE')
    expect(v.reason).toContain('TOL_TOPOLOGY_MERGE')
  })

  it('refuses an area with a genuinely open boundary', () => {
    const v = validateSketchArea({ boundary: square(10).slice(0, 3) })
    expect(v.buildable).toBe(false)
    expect(v.reason).toContain('dropped')
  })

  it('refuses an area carrying a degenerate edge', () => {
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [10, 0] },
      { kind: 'line', start: [10, 0], end: [10, 1e-9] },
      { kind: 'line', start: [10, 1e-9], end: [0, 10] },
      { kind: 'line', start: [0, 10], end: [0, 0] },
    ]
    const v = validateSketchArea({ boundary: loop })
    expect(v.buildable).toBe(false)
    expect(v.reason).toContain('OCC_CONFUSION')
  })
})
