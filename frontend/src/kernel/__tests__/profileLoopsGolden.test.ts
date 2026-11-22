/**
 * The profile-loop golden fixture, replayed against the Rust core on every run.
 *
 * It was generated from the TypeScript implementation that used to live in
 * `kernel/profileLoops.ts`, over the existing unit-test shapes (every edge kind,
 * nesting, the concave probe) plus every surface of the frozen Python-parity
 * topology fixture, so the corpus is real builder output and not hand-built
 * only. `geom-core/tests/profile_loops_golden.rs` replays the same file in
 * cargo, so a drift fails on both sides of the wire.
 *
 * Regenerating after an intentional change: write a new case's expected values
 * from the Rust core with `PROFILE_LOOPS_GOLDEN_WRITE=1` (only new cases need
 * this; the frozen values are the ratchet).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as rust from '@/wasm-kernel/profileLoops'
import { profileLoopsAvailable } from '@/wasm-kernel/profileLoops'
import { CENTROID_ARC_SAMPLES, type LoopEdge } from '../profileLoops'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '../../../..')
const FIXTURE = join(ROOT, 'geom-core/tests/fixtures/profile_loops.json')

interface GoldenOp {
  op: string
  loop?: number
  arcSamples?: number
  point?: number[]
  n?: number
  value?: unknown
}

interface GoldenCase {
  name: string
  loops: LoopEdge[][]
  ops: GoldenOp[]
}

function line(start: number[], end: number[]): LoopEdge {
  return { kind: 'line', start, end }
}

const square = (s: number): LoopEdge[] => [
  line([0, 0], [s, 0]), line([s, 0], [s, s]), line([s, s], [0, s]), line([0, s], [0, 0]),
]

/** A C: back bar on x = 0, arms reaching to x = w, arm thickness t. Its area
 *  centroid falls in the mouth, outside the loop, which is the probe case. */
function cShape(w: number, h: number, t: number, back: number): LoopEdge[] {
  const pts = [
    [0, 0], [0, h], [w, h], [w, h - t], [back, h - t], [back, t], [w, t], [w, 0],
  ]
  return pts.map((p, i) => line(p, pts[(i + 1) % pts.length]))
}

function arcEdge(cx: number, cy: number, r: number, a0: number, a1: number, ccw = true): LoopEdge {
  const at = (deg: number): number[] => {
    const a = (deg * Math.PI) / 180
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  }
  return {
    kind: 'arc',
    center: [cx, cy],
    radius: r,
    angle_start_deg: a0,
    angle_end_deg: a1,
    ccw,
    start: at(a0),
    end: at(a1),
  }
}

function ellipseArcEdge(
  cx: number, cy: number, a: number, b: number, thetaDeg: number,
  p0Deg: number, p1Deg: number, ccw = true,
): LoopEdge {
  const th = (thetaDeg * Math.PI) / 180
  const at = (deg: number): number[] => {
    const phi = (deg * Math.PI) / 180
    const ax = a * Math.cos(phi)
    const ay = b * Math.sin(phi)
    return [cx + ax * Math.cos(th) - ay * Math.sin(th), cy + ax * Math.sin(th) + ay * Math.cos(th)]
  }
  return {
    kind: 'ellipse_arc',
    center: [cx, cy],
    a,
    b,
    theta: thetaDeg,
    angle_start_deg: p0Deg,
    angle_end_deg: p1Deg,
    ccw,
    start: at(p0Deg),
    end: at(p1Deg),
  }
}

/** Every surface of the frozen Python-parity fixture, as profile loops. */
function corpusCases(): GoldenCase[] {
  const fixture = JSON.parse(
    readFileSync(join(HERE, '../occ/__fixtures__/topology.json'), 'utf8'),
  ) as Record<string, { expected: { surfaces?: { boundary: LoopEdge[]; holes?: LoopEdge[][] }[] } }>
  const out: GoldenCase[] = []
  for (const [name, doc] of Object.entries(fixture)) {
    const loops: LoopEdge[][] = []
    for (const surface of doc.expected.surfaces ?? []) {
      loops.push(surface.boundary)
      for (const hole of surface.holes ?? []) loops.push(hole)
    }
    if (loops.length === 0) continue
    const ops: GoldenOp[] = []
    for (let i = 0; i < loops.length; i++) {
      ops.push({ op: 'loopPts', loop: i, arcSamples: 1 })
      ops.push({ op: 'signedArea', loop: i, arcSamples: 1 })
      ops.push({ op: 'centroid', loop: i })
    }
    if (loops.length > 1) {
      ops.push({ op: 'containment', arcSamples: 64 })
      ops.push({ op: 'subdivide' })
    }
    out.push({ name: `corpus/${name}`, loops, ops })
  }
  return out
}

function cases(): GoldenCase[] {
  return [
    {
      name: 'square',
      loops: [square(3)],
      ops: [
        { op: 'loopPts', loop: 0, arcSamples: 1 },
        { op: 'signedArea', loop: 0, arcSamples: 1 },
        { op: 'centroid', loop: 0 },
        { op: 'pointInLoop', loop: 0, arcSamples: 1, point: [1, 1] },
        { op: 'pointInLoop', loop: 0, arcSamples: 1, point: [4, 1] },
      ],
    },
    {
      name: 'circle_two_arcs',
      loops: [[arcEdge(0, 0, 2, 0, 180), arcEdge(0, 0, 2, 180, 360)]],      ops: [
        { op: 'loopPts', loop: 0, arcSamples: 1 },
        { op: 'loopPts', loop: 0, arcSamples: 8 },
        { op: 'signedArea', loop: 0, arcSamples: 1 },
        { op: 'signedArea', loop: 0, arcSamples: 64 },
        { op: 'centroid', loop: 0 },
        { op: 'pointInLoop', loop: 0, arcSamples: 64, point: [1.4, 1.4] },
        { op: 'sampler', loop: 0, n: 3, value: 'arc' },
      ],
    },
    {
      name: 'cw_arc',
      loops: [[arcEdge(1, 2, 1.5, 0, 90, false), arcEdge(1, 2, 1.5, 90, 0, false)]],
      ops: [
        { op: 'loopPts', loop: 0, arcSamples: 4 },
        { op: 'centroid', loop: 0 },
        { op: 'sampler', loop: 0, n: 4, value: 'arc' },
      ],
    },
    {
      name: 'ellipse_arcs',
      loops: [[
        ellipseArcEdge(1, -2, 4, 2, 30, 0, 180),
        ellipseArcEdge(1, -2, 4, 2, 30, 180, 360),
      ]],
      ops: [
        { op: 'loopPts', loop: 0, arcSamples: 4 },
        { op: 'signedArea', loop: 0, arcSamples: 64 },
        { op: 'centroid', loop: 0 },
        { op: 'sampler', loop: 0, n: 5, value: 'ellipseArc' },
      ],
    },
    {
      name: 'full_ellipse_rotated',
      loops: [[{ kind: 'ellipse', center: [10, -5], a: 4, b: 2, theta: 90 }]],
      ops: [
        { op: 'loopPts', loop: 0, arcSamples: 2 },
        { op: 'signedArea', loop: 0, arcSamples: 1 },
        { op: 'centroid', loop: 0 },
        { op: 'sampler', loop: 0, n: 8, value: 'ellipse' },
      ],
    },
    {
      name: 'spline',
      loops: [[{ kind: 'spline', start: [0, 0], c1: [1, 2], c2: [2, -1], end: [3, 1] }]],
      ops: [
        { op: 'loopPts', loop: 0, arcSamples: 8 },
        { op: 'sampler', loop: 0, n: 5, value: 'spline' },
      ],
    },
    {
      name: 'closed_spline',
      loops: [[{ kind: 'spline', start: [0, 0], c1: [4, 0], c2: [4, 3], end: [0, 0] }]],
      ops: [
        // A closed self-loop samples enough points to read as a polygon.
        { op: 'loopPts', loop: 0, arcSamples: 1 },
        { op: 'sampler', loop: 0, n: 6, value: 'spline' },
      ],
    },
    {
      name: 'fit_spline_closed',
      loops: [[{
        kind: 'fit_spline',
        start: [0, 0],
        poles: [
          [0, 0], [1, 0], [2, 0], [3, 0],
          [3, 1], [3, 2], [3, 3],
          [2, 3], [1, 3], [0, 3],
          [0, 2], [0, 1], [0, 0],
        ],
        knots: [0, 1, 2, 3],
      }]],
      ops: [
        { op: 'loopPts', loop: 0, arcSamples: 1 },
        { op: 'sampler', loop: 0, n: 3, value: 'fitSpline' },
        { op: 'signedArea', loop: 0, arcSamples: 1 },
        { op: 'centroid', loop: 0 },
      ],
    },
    {
      name: 'nested_rects',
      loops: [square(10), cShape(6, 6, 2, 1)],
      ops: [
        { op: 'containment', arcSamples: 1 },
        { op: 'containment', arcSamples: 64 },
        { op: 'subdivide' },
      ],
    },
    {
      name: 'nested_c_and_circle',
      loops: [cShape(10, 11, 4, 2), cShape(10, 10, 2, 2), [arcEdge(6, 5, 1, 0, 180), arcEdge(6, 5, 1, 180, 360)]],
      ops: [
        { op: 'containment', arcSamples: 64 },
        { op: 'subdivide' },
        { op: 'centroid', loop: 0 },
      ],
    },
    ...corpusCases(),
  ]
}

function runRust(c: GoldenCase, op: GoldenOp): unknown {
  switch (op.op) {
    case 'loopPts': return rust.loopPts(c.loops[op.loop!], op.arcSamples)
    case 'signedArea': return rust.loopSignedArea(c.loops[op.loop!], op.arcSamples)
    case 'centroid': return rust.loopCentroid(c.loops[op.loop!])
    case 'pointInLoop': return rust.pointInLoop(op.point!, c.loops[op.loop!], op.arcSamples)
    case 'containment': return rust.loopContainment(c.loops, op.arcSamples)
    case 'subdivide': return rust.subdivideLoops(c.loops).map(([outer, holes]) => [
      c.loops.indexOf(outer), holes.map((h) => c.loops.indexOf(h)),
    ])
    case 'sampler': {
      const e = c.loops[op.loop!][0]
      const n = op.n!
      if (op.value === 'arc') return rust.arcSamplePoints(e, n)
      if (op.value === 'ellipseArc') return rust.ellipseArcSamplePoints(e, n)
      if (op.value === 'ellipse') return rust.ellipseSamplePoints(e, n)
      if (op.value === 'spline') return rust.splineSamplePoints(e, n)
      if (op.value === 'fitSpline') return rust.fitSplineSamplePoints(e, n)
      throw new Error(`unknown sampler ${String(op.value)}`)
    }
    default: throw new Error(`unknown op ${op.op}`)
  }
}

function expectClose(got: unknown, want: unknown, path: string): void {
  if (typeof want === 'number' && typeof got === 'number') {
    const scale = Math.max(Math.abs(got), Math.abs(want), 1)
    expect(Math.abs(got - want) <= 1e-12 * scale, `${path}: ${got} != ${want}`).toBe(true)
    return
  }
  if (Array.isArray(want)) {
    expect(Array.isArray(got), `${path}: not an array`).toBe(true)
    const g = got as unknown[]
    expect(g.length, `${path}: length`).toBe(want.length)
    for (let i = 0; i < want.length; i++) expectClose(g[i], want[i], `${path}[${i}]`)
    return
  }
  if (want !== null && typeof want === 'object') {
    expect(got !== null && typeof got === 'object', `${path}: not an object`).toBe(true)
    const g = got as Record<string, unknown>
    const w = want as Record<string, unknown>
    expect(Object.keys(g).sort(), `${path}: keys`).toEqual(Object.keys(w).sort())
    for (const k of Object.keys(w)) expectClose(g[k], w[k], `${path}.${k}`)
    return
  }
  expect(got, path).toEqual(want)
}

const WRITE = process.env.PROFILE_LOOPS_GOLDEN_WRITE === '1'

describe('profile loops golden', () => {
  it('pins the centroid sample count to the Rust mirror', () => {
    expect(CENTROID_ARC_SAMPLES).toBe(64)
  })

  // Only for a NEW case: the frozen expected values are the ratchet, and
  // rewriting them from the implementation under test defeats it.
  it('writes the fixture when asked', () => {
    if (!WRITE || !profileLoopsAvailable()) return
    const all = cases()
    const golden = {
      source: 'frozen from the TS implementation; new cases written by frontend/src/kernel/__tests__/profileLoopsGolden.test.ts',
      version: 1,
      cases: all.map((c) => ({
        name: c.name,
        loops: c.loops,
        ops: c.ops.map((op) => ({ ...op, expected: runRust(c, op) })),
      })),
    }
    writeFileSync(FIXTURE, JSON.stringify(golden, null, 2) + '\n')
    expect(golden.cases.length).toBeGreaterThan(10)
  })

  it('matches the frozen expected values on the Rust path', () => {
    // A fresh checkout without `just wasm` cannot run the facade; the Rust
    // golden suite in cargo covers the algorithm there.
    if (!profileLoopsAvailable()) {
      expect(WRITE).toBe(false)
      return
    }
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      cases: { name: string; loops: LoopEdge[][]; ops: (GoldenOp & { expected: unknown })[] }[]
    }
    for (const c of golden.cases) {
      for (const op of c.ops) {
        const got = runRust(c as GoldenCase, op)
        expectClose(got, op.expected, `${c.name}: ${op.op}`)
      }
    }
  })
})
