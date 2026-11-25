// @vitest-environment node
//
// Real-solver check for materialized intersection points. A point pinned to two
// curves via coincident-to-locus constraints (the locus form of coincident,
// authored by applyAddPointAtIntersection) must sit on BOTH curves after the
// real Rust solve, and keep sitting on both when a circle moves. This is the
// proof that "also constrainable" works with the existing primitive -- no new
// solver constraint, no wasm change.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { loadSolver } from '../loadSolver'
import { lowerSketch } from '../lowerSketch'
import { encodeInput, decodeOutput } from '../codec'
import { partDocToSketches } from '../partDocToSketches'
import { applyAddPointAtIntersection, applyAddConstraint, applyMoveEntity } from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'
import { bezierEval, bezierClosestT, interpolateFitSpline, type Pt } from '@/utils/geometry/fitSpline'

const entities0 = (doc: PartDoc) => featureAt(doc, 0, 'sketch').entities!

const bytes = loadSolver()

function solveFeature(doc: PartDoc): Record<string, number[]> {
  const { sketches, skipped } = partDocToSketches(doc.features)
  expect(skipped).toHaveLength(0)
  expect(sketches).toHaveLength(1)
  const { input, layout } = lowerSketch(sketches[0].sketch)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  return solved
}

// Two circles, externally tangent at (5, 0) in the initial geometry.
function tangentCirclesDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'circA', kind: 'circle' }, { id: 'circB', kind: 'circle' }],
      initial: { circA: [0, 0, 5], circB: [10, 0, 5] },
      constraints: [],
    }],
  }
}

const pointId = (doc: PartDoc) => entities0(doc).find(e => e.kind === 'point')!.id
const distTo = (p: number[], c: number[]) => Math.hypot(p[0] - c[0], p[1] - c[1])

// Distances to the solved loci, using the same point-on-curve forms the
// coincident residual uses. Keeps the "on both curves" assertion independent of
// the solver's own residual report.
const lineDistance = (p: number[], l: number[]): number => {
  const dx = l[2] - l[0]
  const dy = l[3] - l[1]
  return Math.abs((p[0] - l[0]) * -dy + (p[1] - l[1]) * dx) / Math.hypot(dx, dy)
}
const bezierDistance = (p: number[], c: number[]): number => {
  const ctrl: Pt[] = [[c[0], c[1]], [c[2], c[3]], [c[4], c[5]], [c[6], c[7]]]
  const b = bezierEval(ctrl, bezierClosestT(ctrl, [p[0], p[1]]))
  return distTo(p, b)
}
const fitSplineDistance = (p: number[], flat: number[]): number => {
  const points: Pt[] = []
  for (let i = 0; i < flat.length; i += 2) points.push([flat[i], flat[i + 1]])
  return interpolateFitSpline(points).closest([p[0], p[1]]).distance
}
const ellipseSampson = (p: number[], e: number[]): number => {
  const [cx, cy, a, b, theta] = e
  const ct = Math.cos((theta * Math.PI) / 180)
  const st = Math.sin((theta * Math.PI) / 180)
  const dx = p[0] - cx
  const dy = p[1] - cy
  const u = dx * ct + dy * st
  const v = dy * ct - dx * st
  const f = (u * u) / (a * a) + (v * v) / (b * b) - 1
  const grad = 2 * Math.hypot(u / (a * a), v / (b * b))
  return Math.abs(f) / Math.max(grad, 2 / a)
}

// Each fixture pins the curve so a later line move has one crossing. The line
// stays free until it has moved, then is pinned too so the solve must move the
// point rather than dragging either curve back to the old contact.
const pin = (id: string) => ({ id: `fix_${id}`, kind: 'fixed' as const, target: `$${id}` })

// Straight cubic Bezier (0,0)->(10,0) crossing the vertical line x=5 at (5,0).
function splineLineDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ln', kind: 'line' }, { id: 'sp', kind: 'spline' }],
      initial: { ln: [5, -10, 5, 10], sp: [0, 0, 10 / 3, 0, 20 / 3, 0, 10, 0] },
      constraints: [pin('sp')],
    }],
  }
}

function fitSplineLineDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ln', kind: 'line' }, { id: 'fit', kind: 'fit_spline' }],
      initial: { ln: [5, -10, 5, 10], fit: [0, 0, 10, 0] },
      constraints: [pin('fit')],
    }],
  }
}

function ellipseLineDoc(): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'ln', kind: 'line' }, { id: 'ell', kind: 'ellipse' }],
      initial: { ln: [-10, 0, 10, 0], ell: [0, 0, 5, 3, 0] },
      constraints: [pin('ell')],
    }],
  }
}

describe.skipIf(!bytes)('materialized intersection point', () => {
  it('lands on both circles at the tangency', () => {
    const doc = tangentCirclesDoc()
    applyAddPointAtIntersection(doc, 'sk', [5, 0], ['circA', 'circB'])

    const solved = solveFeature(doc)
    const p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    // On both loci: distance to each centre equals that circle's radius.
    expect(distTo(p, [solved.circA[0], solved.circA[1]])).toBeCloseTo(solved.circA[2], 4)
    expect(distTo(p, [solved.circB[0], solved.circB[1]])).toBeCloseTo(solved.circB[2], 4)
    // The tangency is at (5, 0); the point holds there.
    expect(p[0]).toBeCloseTo(5, 3)
    expect(p[1]).toBeCloseTo(0, 3)
  })

  it('stays on both curves after a circle moves', () => {
    const doc = tangentCirclesDoc()
    applyAddPointAtIntersection(doc, 'sk', [5, 0], ['circA', 'circB'])
    // Slide circB inward so the two circles now overlap (intersect at two points).
    applyMoveEntity(doc, 'sk', 'circB', [-1, 0])

    const solved = solveFeature(doc)
    const p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    // The coincidences rode along: the point is still on both loci.
    expect(distTo(p, [solved.circA[0], solved.circA[1]])).toBeCloseTo(solved.circA[2], 4)
    expect(distTo(p, [solved.circB[0], solved.circB[1]])).toBeCloseTo(solved.circB[2], 4)
  })

  it('pins a materialized point to a spline and a line, then follows the line', () => {
    const doc = splineLineDoc()
    applyAddPointAtIntersection(doc, 'sk', [5, 0], ['sp', 'ln'])
    let solved = solveFeature(doc)
    let p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    expect(bezierDistance(p, solved.sp)).toBeLessThan(1e-3)
    expect(lineDistance(p, solved.ln)).toBeLessThan(1e-3)

    // Slide the line to x=6: the point must leave the old crossing with it.
    applyMoveEntity(doc, 'sk', 'ln', [1, 0])
    applyAddConstraint(doc, 'sk', 'fixed', ['$ln'])
    solved = solveFeature(doc)
    p = solved[pointId(doc)]
    expect(p[0]).toBeCloseTo(6, 3)
    expect(p[1]).toBeCloseTo(0, 3)
    expect(bezierDistance(p, solved.sp)).toBeLessThan(1e-3)
    expect(lineDistance(p, solved.ln)).toBeLessThan(1e-3)
  })

  it('pins a materialized point to a fit spline and a line, then follows the line', () => {
    const doc = fitSplineLineDoc()
    applyAddPointAtIntersection(doc, 'sk', [5, 0], ['fit', 'ln'])
    let solved = solveFeature(doc)
    let p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    expect(fitSplineDistance(p, solved.fit)).toBeLessThan(1e-3)
    expect(lineDistance(p, solved.ln)).toBeLessThan(1e-3)

    applyMoveEntity(doc, 'sk', 'ln', [1, 0])
    applyAddConstraint(doc, 'sk', 'fixed', ['$ln'])
    solved = solveFeature(doc)
    p = solved[pointId(doc)]
    expect(p[0]).toBeCloseTo(6, 3)
    expect(p[1]).toBeCloseTo(0, 3)
    expect(fitSplineDistance(p, solved.fit)).toBeLessThan(1e-3)
    expect(lineDistance(p, solved.ln)).toBeLessThan(1e-3)
  })

  it('pins a materialized point to an ellipse and a line, then follows the line', () => {
    const doc = ellipseLineDoc()
    applyAddPointAtIntersection(doc, 'sk', [5, 0], ['ell', 'ln'])
    let solved = solveFeature(doc)
    let p = solved[pointId(doc)]
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    expect(ellipseSampson(p, solved.ell)).toBeLessThan(1e-3)
    expect(lineDistance(p, solved.ln)).toBeLessThan(1e-3)

    // Lift the line to y=1: the point must track the new ellipse crossing.
    applyMoveEntity(doc, 'sk', 'ln', [0, 1])
    applyAddConstraint(doc, 'sk', 'fixed', ['$ln'])
    solved = solveFeature(doc)
    p = solved[pointId(doc)]
    expect(p[1]).toBeCloseTo(1, 3)
    expect(ellipseSampson(p, solved.ell)).toBeLessThan(1e-3)
    expect(lineDistance(p, solved.ln)).toBeLessThan(1e-3)
  })
})
