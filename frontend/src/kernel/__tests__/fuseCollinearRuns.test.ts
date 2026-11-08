// Pure unit tests for the profile collinear-run fuse: a sketch line split by a
// construction line, or collinear authored lines meeting end to end, is one
// lateral face on the solid. No OCC here; the real-kernel cases live in the
// drive suite.

import { describe, it, expect } from 'vitest'
import { fuseCollinearRuns, type LoopEdge } from '../profileLoops'
import { extractProfileLoops } from '../features/shared/profileLoops'

const line = (id: string, x0: number, y0: number, x1: number, y1: number): LoopEdge => ({
  kind: 'line', id, start: [x0, y0], end: [x1, y1],
})

const arc = (
  id: string,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  ccw = true,
): LoopEdge => ({
  kind: 'arc',
  id,
  center: [cx, cy],
  radius: r,
  angle_start_deg: a0,
  angle_end_deg: a1,
  ccw,
  start: [cx + r * Math.cos(a0 * Math.PI / 180), cy + r * Math.sin(a0 * Math.PI / 180)],
  end: [cx + r * Math.cos(a1 * Math.PI / 180), cy + r * Math.sin(a1 * Math.PI / 180)],
})

describe('fuseCollinearRuns', () => {
  it('merges a square bottom side made of two collinear lines', () => {
    const loop: LoopEdge[] = [
      line('a', 0, 0, 5, 0),
      line('b', 5, 0, 10, 0),
      line('c', 10, 0, 10, 10),
      line('d', 10, 10, 0, 10),
      line('e', 0, 10, 0, 0),
    ]
    const out = fuseCollinearRuns(loop)
    expect(out).toHaveLength(4)
    const merged = out.find((e) => Array.isArray(e.mergedIds) && (e.mergedIds as string[]).length === 2)
    expect(merged).toBeDefined()
    expect(merged!.mergedIds).toEqual(['a', 'b'])
    expect(merged!.id).toBe('a')  // smallest id
    expect(merged!.start).toEqual([0, 0])
    expect(merged!.end).toEqual([10, 0])
  })

  it('keeps id and one mergedId for one entity split into two pieces', () => {
    const loop: LoopEdge[] = [
      line('x', 0, 0, 5, 0),
      line('x', 5, 0, 10, 0),
      line('c', 10, 0, 10, 10),
      line('d', 10, 10, 0, 10),
      line('e', 0, 10, 0, 0),
    ]
    const out = fuseCollinearRuns(loop)
    expect(out).toHaveLength(4)
    const merged = out.find((e) => (e.start as number[])[1] === 0 && (e.end as number[])[1] === 0)
    expect(merged!.id).toBe('x')
    expect(merged!.mergedIds).toEqual(['x'])
    expect(merged!.start).toEqual([0, 0])
    expect(merged!.end).toEqual([10, 0])
  })

  it('keeps every alias when an already-fused run is fused again', () => {
    const loop: LoopEdge[] = [
      line('a', 0, 0, 5, 0),
      line('b', 5, 0, 10, 0),
      line('c', 10, 0, 10, 10),
      line('d', 10, 10, 0, 10),
      line('e', 0, 10, 0, 0),
    ]
    const once = fuseCollinearRuns(loop)
    const twice = fuseCollinearRuns(once)
    expect(twice).toHaveLength(4)
    const merged = twice.find((e) => Array.isArray(e.mergedIds) && (e.mergedIds as string[]).length === 2)
    expect(merged!.mergedIds).toEqual(['a', 'b'])
    expect(merged!.id).toBe('a')
  })

  it('merges a run that wraps the loop start', () => {
    const loop: LoopEdge[] = [
      line('a', 9, 0, 10, 0),  // last piece of the bottom side
      line('b', 10, 0, 10, 10),
      line('c', 10, 10, 0, 10),
      line('d', 0, 10, 0, 0),
      line('e', 0, 0, 5, 0),  // first piece of the bottom side
      line('f', 5, 0, 9, 0),
    ]
    const out = fuseCollinearRuns(loop)
    expect(out).toHaveLength(4)
    const merged = out.find((e) => Array.isArray(e.mergedIds) && (e.mergedIds as string[]).length === 3)
    expect(merged).toBeDefined()
    expect(merged!.mergedIds).toEqual(['e', 'f', 'a'])
    expect(merged!.start).toEqual([0, 0])
    expect(merged!.end).toEqual([10, 0])
  })

  it('does not merge an L corner', () => {
    const loop: LoopEdge[] = [
      line('a', 0, 0, 10, 0),
      line('b', 10, 0, 10, 10),
      line('c', 10, 10, 0, 10),
      line('d', 0, 10, 0, 0),
    ]
    expect(fuseCollinearRuns(loop)).toHaveLength(4)
  })

  it('merges a solver-residual kink but not a visible bend', () => {
    const loopWithKink = (dy: number): LoopEdge[] => [
      line('a', 0, 0, 5, 0),
      line('b', 5, 0, 10, dy),
      line('c', 10, dy, 10, 10),
      line('d', 10, 10, 0, 10),
      line('e', 0, 10, 0, 0),
    ]
    // 1e-7 rad, the residual an exactly-collinear solve can leave.
    expect(fuseCollinearRuns(loopWithKink(5e-7))).toHaveLength(4)
    // 1e-3 rad is a drawn bend.
    expect(fuseCollinearRuns(loopWithKink(5e-3))).toHaveLength(5)
  })

  it('does not merge a reversal (spike)', () => {
    const loop: LoopEdge[] = [
      line('a', 0, 0, 10, 0),
      line('b', 10, 0, 0, 0),  // reverses along the same line
      line('c', 0, 0, 0, 10),
      line('d', 0, 10, 0, 0),
    ]
    expect(fuseCollinearRuns(loop)).toHaveLength(4)
  })

  it('does not fuse across the T-junction of two areas of one extrude', () => {
    // Two adjacent areas: each loop owns the shared vertical side at x=0, so a
    // top run from x=-5 to x=5 would exist only if the fuse crossed loops and
    // dropped the internal wall.
    const left: Record<string, unknown>[] = [
      line('l-top', -5, 5, 0, 5),
      line('l-right', 0, 5, 0, 0),
      line('l-bottom', 0, 0, -5, 0),
      line('l-left', -5, 0, -5, 5),
    ]
    const right: Record<string, unknown>[] = [
      line('r-top', 0, 5, 5, 5),
      line('r-right', 5, 5, 5, 0),
      line('r-bottom', 5, 0, 0, 0),
      line('r-left', 0, 0, 0, 5),
    ]
    const loops = extractProfileLoops([{ boundary: left }, { boundary: right }])
    expect(loops).toHaveLength(2)
    const fused = loops.map(fuseCollinearRuns)
    expect(fused.map((loop) => loop.length)).toEqual([4, 4])
    for (const loop of fused) {
      for (const edge of loop) {
        expect([(edge.start as number[])[0], (edge.end as number[])[0]]).not.toEqual([-5, 5])
      }
    }
  })

  it('merges two arcs of one circle into a full-turn arc', () => {
    const loop: LoopEdge[] = [arc('a', 0, 0, 5, 0, 180), arc('b', 0, 0, 5, 180, 360)]
    const out = fuseCollinearRuns(loop)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('arc')
    expect(out[0].angle_start_deg).toBe(0)
    expect(out[0].angle_end_deg).toBe(360)
    expect(out[0].mergedIds).toEqual(['a', 'b'])
  })

  it('does not merge arcs of different circles (peanut)', () => {
    // The peanut's outer boundary: two radius-5 arcs on circles centred at
    // (-3, 0) and (3, 0), meeting at (0, +/-4). Same radius, different centre.
    const top = Math.atan2(4, 3) * 180 / Math.PI
    const topMirror = Math.atan2(4, -3) * 180 / Math.PI
    const loop: LoopEdge[] = [
      arc('a', -3, 0, 5, top, 360 - top),
      arc('b', 3, 0, 5, 360 - topMirror, topMirror + 360),
    ]
    const out = fuseCollinearRuns(loop)
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.id).sort()).toEqual(['a', 'b'])
  })
})

describe('extractProfileLoops collinear fuse', () => {
  it('publishes one loop when two areas report the same boundary with different splits', () => {
    const square = (top: LoopEdge[]): Record<string, unknown>[] => [
      ...top,
      line('r', 10, 0, 10, 10),
      line('t', 10, 10, 0, 10),
      line('l', 0, 10, 0, 0),
    ] as Record<string, unknown>[]
    const whole = square([line('b', 0, 0, 10, 0)])
    const split = square([line('b', 0, 0, 5, 0), line('b', 5, 0, 10, 0)])
    const loops = extractProfileLoops([
      { boundary: whole },
      { boundary: split },
    ])
    expect(loops).toHaveLength(1)
    // The assembler keeps the traced pieces (classification needs them); only
    // its duplicate key is computed on the fused form.
    expect(loops[0]).toHaveLength(4)
  })
})
