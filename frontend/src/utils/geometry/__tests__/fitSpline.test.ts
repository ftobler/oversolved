/**
 * Golden parity for the TypeScript fit-spline mirror.
 *
 * It reads the SAME fixture the Rust crate does (`golden.json`, generated from
 * OCP by `tests/fit_spline_golden.py`), so OCP == Rust == TS is one test pair
 * rather than three hand-written oracles.
 */
import { describe, expect, it } from 'vitest'
import golden from '../../../../../sketch-solver/src/fit_spline/golden.json'
import {
  chordParams,
  FitSplineError,
  fitSplineFromParams,
  handlesFromTangents,
  interpolateFitSpline,
  scaleTangents,
  type Pt,
} from '../fitSpline'

interface GoldenCase {
  name: string
  points: number[][]
  handle_start: number[] | null
  handle_end: number[] | null
  tangents: Array<number[] | null>
  scale: boolean
  degree: number
  poles: number[][]
  knots: number[]
  chain: number[][]
  tangent_start: number[]
  tangent_end: number[]
  samples: number[][][]
}

const cases = (golden as { cases: GoldenCase[] }).cases

function pt(v: number[]): Pt {
  return [v[0], v[1]]
}

function close(actual: number, expected: number, what: string): void {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1)
  expect(Math.abs(actual - expected), `${what}: ${actual} != ${expected}`).toBeLessThanOrEqual(1e-12 * scale)
}

function pointsClose(actual: readonly Pt[], expected: readonly Pt[], what: string): void {
  expect(actual.length, `${what}: length`).toBe(expected.length)
  actual.forEach((p, i) => {
    close(p[0], expected[i][0], `${what}[${i}].x`)
    close(p[1], expected[i][1], `${what}[${i}].y`)
  })
}

describe('fit spline golden parity', () => {
  for (const c of cases) {
    it(`${c.name} matches OCP`, () => {
      const points = c.points.map(pt)
      const curve = interpolateFitSpline(
        points,
        c.handle_start ? pt(c.handle_start) : null,
        c.handle_end ? pt(c.handle_end) : null,
      )
      pointsClose(curve.poles(), c.chain.map(pt), 'chain')

      const us = chordParams(points)
      pointsClose(
        curve.knots.map(u => [u, 0] as Pt),
        us.map(u => [u, 0] as Pt),
        'chord params',
      )
      pointsClose([curve.derivatives[0]], [pt(c.tangent_start)], 'start derivative')
      pointsClose([curve.derivatives[curve.derivatives.length - 1]], [pt(c.tangent_end)], 'end derivative')

      c.samples.forEach((span, i) => {
        span.forEach((expected, k) => {
          const fraction = (k + 1) / 10
          const u = us[i] + (us[i + 1] - us[i]) * fraction
          const actual = curve.eval(u)
          close(actual[0], expected[0], `${c.name} span ${i} sample ${k}.x`)
          close(actual[1], expected[1], `${c.name} span ${i} sample ${k}.y`)
        })
      })

      if (c.degree === 3) {
        expect(curve.knots.length).toBe(c.knots.length)
        curve.knots.forEach((u, i) => close(u, c.knots[i], `${c.name} knot ${i}`))
      }
    })
  }

  it('scaleTangents reproduces the OCCT rule for every scaled case', () => {
    for (const c of cases.filter(c => c.scale)) {
      const points = c.points.map(pt)
      const tangents = c.tangents.map(t => (t ? pt(t) : null))
      const scaled = scaleTangents(points, tangents)
      // The scaled start/end vectors are exactly the end derivatives OCP used.
      if (tangents[0]) pointsClose([scaled[0] as Pt], [pt(c.tangent_start)], `${c.name} start`)
      if (tangents[tangents.length - 1]) {
        pointsClose([scaled[scaled.length - 1] as Pt], [pt(c.tangent_end)], `${c.name} end`)
      }
    }
  })

  it('handlesFromTangents stores the scaled handle points', () => {
    for (const c of cases.filter(c => c.scale)) {
      const points = c.points.map(pt)
      const tangents = c.tangents.map(t => (t ? pt(t) : null))
      const handles = handlesFromTangents(points, tangents, true)
      if (c.handle_start) pointsClose([handles.handleStart as Pt], [pt(c.handle_start)], `${c.name} start handle`)
      if (c.handle_end) pointsClose([handles.handleEnd as Pt], [pt(c.handle_end)], `${c.name} end handle`)
    }
  })

  it('the unscaled handle conversion keeps the authored magnitudes', () => {
    for (const c of cases.filter(c => !c.scale && c.tangents.some(t => t))) {
      const points = c.points.map(pt)
      const tangents = c.tangents.map(t => (t ? pt(t) : null))
      const handles = handlesFromTangents(points, tangents, false)
      if (c.handle_start) pointsClose([handles.handleStart as Pt], [pt(c.handle_start)], `${c.name} start handle`)
      if (c.handle_end) pointsClose([handles.handleEnd as Pt], [pt(c.handle_end)], `${c.name} end handle`)
    }
  })
})

describe('fit spline param decoding', () => {
  it('reads points then handles in the document order', () => {
    const params = [0, 1, 2, 3, 4, 5, 6, 7]
    const curve = fitSplineFromParams(params, 'both')
    expect(curve.points).toEqual([
      [0, 1],
      [2, 3],
    ])
    expect(curve.derivatives.length).toBe(2)
  })

  it('refuses an odd or short block', () => {
    expect(() => fitSplineFromParams([0, 0, 1, 1, 2], null)).toThrow(FitSplineError)
    expect(() => fitSplineFromParams([0, 0], null)).toThrow(FitSplineError)
  })
})
