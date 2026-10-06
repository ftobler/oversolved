// @vitest-environment node
//
// Real-solver check of the n-gon's construction circumcircle. The DOF and the
// "no redundant constraint" claim are measured on the actual Rust solver, not
// argued: a regular N-gon family has 4 DOF (x, y, scale, rotation), the circle
// adds 3 params, and the lowered coupling must take exactly those 3 back with
// every row independent.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { loadSolver } from '../loadSolver'
import { lowerSketch } from '../lowerSketch'
import { encodeInput, decodeOutput, Status, type SolverOutput } from '../codec'
import { partDocToSketches } from '../partDocToSketches'
import { applyAddNgon, applyAddConstraint, applyDeleteElements } from '@/utils/yamlMutations'

const bytes = loadSolver()

interface Solved { out: SolverOutput; params: Record<string, number[]>; rows: number }

type Lowered = Record<string, unknown> & { kind: string; a?: { point?: string }; b?: { point?: string } }

// Residual rows each lowered constraint contributes, per the solver's residual
// functions: a point-point coincident is 2 rows, a point-on-curve coincident
// (the locus form, no vertex key on `b`) is 1, and equal_length, angle and
// radius are 1 each. Used to prove rank === rows, i.e. nothing is redundant.
function rowsOf(c: Lowered): number {
  if (c.kind === 'coincident') return c.b && ('external_xy' in c.b || c.b.point) ? 2 : 1
  return 1
}

// lowerSketch always appends the projected origin point with a fixed pin.
const ORIGIN_PIN_ROWS = 2

function solve(doc: PartDoc): Solved {
  const { sketches, skipped } = partDocToSketches(doc.features)
  expect(skipped).toHaveLength(0)
  const sketch = sketches[0].sketch
  const { input, layout } = lowerSketch(sketch)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const params: Record<string, number[]> = {}
  for (const l of layout) params[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  const rows = (sketch.constraints as Lowered[]).reduce((s, c) => s + rowsOf(c), ORIGIN_PIN_ROWS)
  return { out, params, rows }
}

function emptySketch(): PartDoc {
  return { features: [{ id: 'sk', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

const feat = (doc: PartDoc): PartFeature => doc.features![0]
const circleId = (doc: PartDoc) => feat(doc).entities!.find((e) => e.kind === 'circle')!.id
const lineIds = (doc: PartDoc) => feat(doc).entities!.filter((e) => e.kind === 'line').map((e) => e.id)

// Every polygon vertex sits on the solved circle and the sides are equal.
function expectRegularOn(doc: PartDoc, s: Solved, center: [number, number], r: number): void {
  const lines = lineIds(doc).map((id) => s.params[id])
  const len0 = Math.hypot(lines[0][2] - lines[0][0], lines[0][3] - lines[0][1])
  for (const p of lines) {
    expect(Math.hypot(p[0] - center[0], p[1] - center[1])).toBeCloseTo(r, 2)
    expect(Math.hypot(p[2] - p[0], p[3] - p[1])).toBeCloseTo(len0, 2)
  }
}

describe.skipIf(!bytes)('n-gon construction circumcircle on the real solver', () => {
  for (const sides of [3, 4, 6, 8]) {
    it(`fresh ${sides}-gon: 4 DOF, every row independent, feasible`, () => {
      const doc = emptySketch()
      applyAddNgon(doc, 'sk', [1, 2], [11, 2], sides)
      const s = solve(doc)
      // Measured: dof === 4 (x, y, scale, rotation) for every side count.
      expect(s.out.diagnostics.dof).toBe(4)
      expect(s.out.diagnostics.rank).toBe(s.rows)
      expect(s.out.overallStatus).toBe(Status.underconstrained)
      expect(s.out.diagnostics.residualNorm).toBeLessThan(1e-4)
      const c = s.params[circleId(doc)]
      expect(c[0]).toBeCloseTo(1, 3)
      expect(c[1]).toBeCloseTo(2, 3)
      expect(c[2]).toBeCloseTo(10, 3)
    })
  }

  it('the circle without the coupling would be 3 extra DOF (the coupling is what binds it)', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 6)
    delete feat(doc).constraints!.find((c) => c.kind === 'ngon')!.circle
    const s = solve(doc)
    expect(s.out.diagnostics.dof).toBe(7)
    expect(s.out.diagnostics.rank).toBe(s.rows)
  })

  // Control for the rank === rows check: putting every vertex on the circle
  // leaves the DOF unchanged but makes the extra rows redundant, and the check
  // sees it. This is why the lowering pins exactly three.
  it('pinning every vertex instead would be redundant (rank < rows)', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 6)
    const cid = circleId(doc)
    for (const lid of lineIds(doc)) {
      applyAddConstraint(doc, 'sk', 'coincident', [`vertex:sk:${lid}:start`, `entity:sk:${cid}`])
    }
    const s = solve(doc)
    expect(s.out.diagnostics.dof).toBe(4)
    expect(s.out.diagnostics.rank).toBeLessThan(s.rows)
  })

  it('moving the circle center moves the whole polygon', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [5, 3], [15, 3], 6)
    const cid = circleId(doc)
    applyAddConstraint(doc, 'sk', 'coincident', [`vertex:sk:${cid}:center`, '@builtin_origin'])
    const s = solve(doc)
    const c = s.params[cid]
    expect(Math.hypot(c[0], c[1])).toBeLessThan(1e-3)
    expect(s.out.diagnostics.dof).toBe(2)
    expectRegularOn(doc, s, [c[0], c[1]], c[2])
  })

  it('a snapped centerRef on the origin authors that same pin', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 5, null, '@builtin_origin')
    const s = solve(doc)
    const c = s.params[circleId(doc)]
    expect(Math.hypot(c[0], c[1])).toBeLessThan(1e-3)
    // Only x and y are taken: scale and rotation stay free.
    expect(s.out.diagnostics.dof).toBe(2)
    expect(s.out.diagnostics.rank).toBe(s.rows)
  })

  it('a radius dimension on the circle scales the polygon', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 6)
    applyAddConstraint(doc, 'sk', 'radius', [`entity:sk:${circleId(doc)}`], 20)
    const s = solve(doc)
    const c = s.params[circleId(doc)]
    expect(c[2]).toBeCloseTo(20, 2)
    expectRegularOn(doc, s, [c[0], c[1]], 20)
    expect(s.out.diagnostics.dof).toBe(3)
  })

  it('deleting the ngon constraint frees both the polygon and the circle', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 6)
    const ngon = feat(doc).constraints!.find((c) => c.kind === 'ngon')!
    applyDeleteElements(doc, [`constraint:sk:${ngon.id}`])
    const s = solve(doc)
    // 6 chained lines (24 params, 12 coincident rows) + a free circle (3).
    expect(s.out.diagnostics.dof).toBe(15)
  })

  it('deleting the circle leaves the regular polygon at its 4 DOF', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 6)
    applyDeleteElements(doc, [`entity:sk:${circleId(doc)}`])
    const s = solve(doc)
    expect(s.out.diagnostics.dof).toBe(4)
    expect(s.out.diagnostics.rank).toBe(s.rows)
  })
})
