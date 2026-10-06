// @vitest-environment node
//
// Real-solver regression for bugreports/ellipse_slice_error{,2,3}: a line whose
// end point is constrained onto an ellipse forms a chord that should slice the
// ellipse into two areas. The solver only places "point on ellipse" to within
// its residual (~3e-8 perpendicular, amplified along the near-tangent secant),
// so the line-end vertex and the line/ellipse intersection computed there must
// merge for the cut to close. This drives the actual Rust solver (not a captured
// snapshot) so the assertion reflects the true solved residual.
//
// Skips when the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { lowerSketch } from '@/wasm-kernel/lowerSketch'
import { encodeInput, decodeOutput } from '@/wasm-kernel/codec'
import { enrichSketchEntity } from '../postRegister'
import { detectTopology, topologyAvailable } from '../../topologyTestUtil'

const bytes = loadSolver()

// Implicit ellipse residual at p: 0 exactly on the rim. Confirms the solver left
// the endpoint genuinely (approximately) on the ellipse, so a passing surface
// count is not an accident of an unsatisfied constraint.
function ellipseResidual(p: number[], el: number[]): number {
  const [cx, cy, a, b, theta] = el
  const cr = Math.cos((theta * Math.PI) / 180)
  const sr = Math.sin((theta * Math.PI) / 180)
  const dx = p[0] - cx
  const dy = p[1] - cy
  const xl = dx * cr + dy * sr
  const yl = -dx * sr + dy * cr
  return (xl * xl) / (a * a) + (yl * yl) / (b * b) - 1
}

// The three reported line start points (end is fixed, constrained onto the rim).
// "one/two quadrant(s)" is how the reporter described how much the chord cuts off.
const cases: Array<[string, [number, number]]> = [
  ['one quadrant', [-7.447084903717041, -0.10095799714326859]],
  ['one quadrant, nearer rim', [-6.315125942230225, -0.2938689887523651]],
  ['two quadrants', [4.364737033843994, 1.8953800201416016]],
]

function solveAndSlice(start: [number, number]): { surfaces: number; residual: number } {
  const sketch = {
    id: 'sk',
    entities: [
      { id: 'e1', kind: 'ellipse' },
      { id: 'l1', kind: 'line' },
    ],
    initial: {
      e1: [-8.874304936734578e-12, 3.902195927496521e-11, 5, 2.5, -3.471258003262534e-11],
      l1: [start[0], start[1], -2.0701122283935547, 2.2756667137145996],
    },
    constraints: [
      { kind: 'horizontal', a: { entity: 'e1', point: 'major1' }, b: { entity: 'e1', point: 'major2' } },
      { kind: 'point_distance', a: { entity: 'e1', point: 'major1' }, b: { entity: 'e1', point: 'major2' }, value: 10 },
      { kind: 'point_distance', a: { entity: 'e1', point: 'minor1' }, b: { entity: 'e1', point: 'minor2' }, value: 5 },
      { kind: 'coincident', a: { entity: 'e1', point: 'center' }, b: { external_xy: [0, 0] } },
      { kind: 'coincident', a: { entity: 'l1', point: 'end' }, b: { entity: 'e1' } },
    ],
  }
  const { input, layout } = lowerSketch(sketch)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  const rich = {
    e1: enrichSketchEntity('ellipse', solved.e1),
    l1: enrichSketchEntity('line', solved.l1),
  }
  const topo = detectTopology(rich, 'sk')
  return { surfaces: topo.surfaces.length, residual: ellipseResidual([solved.l1[2], solved.l1[3]], solved.e1) }
}

describe.skipIf(!bytes || !topologyAvailable)('chord whose endpoint is solved onto an ellipse slices it in two', () => {
  for (const [name, start] of cases) {
    it(`${name}: two areas after the real solve`, () => {
      const { surfaces, residual } = solveAndSlice(start)
      // The endpoint really did land on the rim (within solver precision)...
      expect(Math.abs(residual)).toBeLessThan(1e-6)
      // ...and the chord closed against the elliptical arcs into two areas.
      expect(surfaces).toBe(2)
    })
  }
})
