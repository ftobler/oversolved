// @vitest-environment node
//
// A line tangent to a spline at an interior point, through the real Rust
// solver: a coincident puts the line start on the spline and the tangent makes
// the line follow the spline's direction THERE. The row used to read the Bezier
// at its midpoint and the fit spline at the point nearest the line start, so
// the solve converged to a line parallel to the wrong tangent ("line tangential
// to a bezier or multipoint spline yields wrong results"). Skips when the
// gitignored pkg-node build is absent (run `just wasm`).
import { describe, it, expect, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import {
  bezierClosestT, bezierDeriv, fitSplineFromParams, type Pt,
} from '@/utils/geometry/fitSpline'
import type { Repository } from '../../query'
import type { PartSolid } from '../../types3d'

type Dict = Record<string, unknown>

const solveBytes = loadSolver()
const repo = { query: () => null, elements: new Map() } as unknown as Repository

/** An arch whose midpoint tangent is horizontal and whose quarter tangent is not. */
const ARCH = [0, 0, 1, 2, 3, 2, 4, 0]
const FIT_ARCH = [0, 0, 2, 2, 4, 0]

function feature(
  kind: 'spline' | 'fit_spline',
  params: number[],
  line: number[],
  contact: 'start' | 'end' = 'start',
): Dict {
  return {
    id: 'sk1',
    kind: 'sketch',
    plane: '@builtin_plane_front',
    entities: [{ id: 's1', kind }, { id: 'l1', kind: 'line' }],
    initial: { s1: params, l1: line },
    constraints: [
      { id: 'c1', kind: 'fixed', target: { entity: 's1' } },
      { id: 'c2', kind: 'coincident', a: `$l1${contact}`, b: '$s1' },
      { id: 'c3', kind: 'tangent', a: '$l1', b: '$s1' },
    ],
  }
}

function solvedLine(f: Dict): number[] {
  const out = solveSketch(f, repo, {} as Record<string, PartSolid>) as Dict
  expect(out.dropped_constraints ?? []).toEqual([])
  return (out.geometry as Record<string, number[]>).l1
}

const unit = (v: Pt): Pt => {
  const n = Math.hypot(v[0], v[1])
  return [v[0] / n, v[1] / n]
}
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0]

describe.skipIf(!solveBytes)('line tangent to a spline at an interior contact (real solver)', () => {
  beforeEach(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('a Bezier: the line follows the spline tangent at its start, not the midpoint one', () => {
    // Start near t = 0.25 (about (0.66, 1.13)), end off any tangent.
    const line = solvedLine(feature('spline', ARCH, [0.66, 1.13, 3.5, 0.5]))
    const ctrl: Pt[] = [[0, 0], [1, 2], [3, 2], [4, 0]]
    const start: Pt = [line[0], line[1]]
    const tan = unit(bezierDeriv(ctrl, bezierClosestT(ctrl, start)))
    const dir = unit([line[2] - line[0], line[3] - line[1]])
    expect(Math.abs(cross(dir, tan))).toBeLessThan(1e-6)
    // The midpoint tangent is horizontal; the contact's is clearly not.
    expect(Math.abs(dir[1])).toBeGreaterThan(0.3)
  })

  it('a fit spline: the line follows the spline tangent at its end, the contact', () => {
    // The contact is the line END: the old row projected the line START, a
    // point the coincident never put on the curve.
    const line = solvedLine(feature('fit_spline', FIT_ARCH, [3.5, 0.5, 0.66, 1.0], 'end'))
    const curve = fitSplineFromParams(FIT_ARCH)
    const end: Pt = [line[2], line[3]]
    const hit = curve.closest(end)
    // Within the solve's verdict width, not bit-exact: the TS closest-point
    // search is a separate implementation of the Rust one.
    expect(hit.distance).toBeLessThan(1e-5)
    const tan = unit(curve.deriv(hit.u))
    const dir = unit([line[2] - line[0], line[3] - line[1]])
    expect(Math.abs(cross(dir, tan))).toBeLessThan(1e-5)
    expect(Math.abs(dir[1])).toBeGreaterThan(0.3)
  })
})
