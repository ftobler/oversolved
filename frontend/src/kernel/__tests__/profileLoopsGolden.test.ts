/**
 * The profile-loop golden fixture: generated from the TypeScript implementation
 * (while it existed), then replayed by `geom-core/tests/profile_loops_golden.rs`
 * and here on every run.
 *
 * Generating: `PROFILE_LOOPS_GOLDEN_WRITE=1 npx vitest run
 * src/kernel/__tests__/profileLoopsGolden.test.ts` writes
 * `geom-core/tests/fixtures/profile_loops.json`. The cases are the existing
 * unit-test shapes (every edge kind, nesting, the concave probe) plus every
 * surface of the frozen Python-parity topology fixture, so the corpus is real
 * builder output, not hand-built only.
 *
 * While both implementations exist this suite is the parity window: it runs the
 * TS functions and the Rust facade over the same cases and compares them
 * exactly. After the TS implementation is deleted it verifies the facade
 * against the frozen expected values instead.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from '../profileLoops'
import * as rust from '../profileLoopsRust'
import { profileLoopsAvailable } from '../profileLoopsRust'
import type { LoopEdge } from '../profileLoops'

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

function runTs(c: GoldenCase, op: GoldenOp): unknown {
  switch (op.op) {
    case 'loopPts': return ts.loopPts(c.loops[op.loop!], op.arcSamples)
    case 'signedArea': return ts.loopSignedArea(c.loops[op.loop!], op.arcSamples)
    case 'centroid': return ts.loopCentroid(c.loops[op.loop!])
    case 'pointInLoop': return ts.pointInLoop(op.point!, c.loops[op.loop!], op.arcSamples)
    case 'containment': return ts.loopContainment(c.loops, op.arcSamples)
    case 'subdivide': return ts.subdivideLoops(c.loops).map(([outer, holes]) => [
      c.loops.indexOf(outer), holes.map((h) => c.loops.indexOf(h)),
    ])
    case 'sampler': {
      const e = c.loops[op.loop!][0]
      const n = op.n!
      if (op.value === 'arc') return ts.arcSamplePoints(e, n)
      if (op.value === 'ellipseArc') return ts.ellipseArcSamplePoints(e, n)
      if (op.value === 'ellipse') return ts.ellipseSamplePoints(e, n)
      if (op.value === 'spline') return ts.splineSamplePoints(e, n)
      if (op.value === 'fitSpline') return ts.fitSplineSamplePoints(e, n)
      throw new Error(`unknown sampler ${String(op.value)}`)
    }
    default: throw new Error(`unknown op ${op.op}`)
  }
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
  it('writes the fixture when asked', () => {
    if (!WRITE) return
    const all = cases()
    const golden = {
      source: 'generated by frontend/src/kernel/__tests__/profileLoopsGolden.test.ts from the TS implementation',
      version: 1,
      cases: all.map((c) => ({
        name: c.name,
        loops: c.loops,
        ops: c.ops.map((op) => ({ ...op, expected: runTs(c, op) })),
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

  // The parity window: one commit where both implementations exist, compared
  // over the same corpus. Deleted together with the TS implementation.
  it('matches the TS implementation while it still exists', () => {
    if (typeof ts.loopPts !== 'function' || !profileLoopsAvailable()) return
    for (const c of cases()) {
      for (const op of c.ops) {
        const a = runTs(c, op)
        const b = runRust(c, op)
        expectClose(b, a, `${c.name}: ${op.op}`)
      }
    }
  })
})
