// @vitest-environment node
//
// Rev 3 wire regression at part scale: a line tangent to an arc at x = 1500 mm,
// solved by the real WASM kernel, must produce a closed profile whose OCC wire
// builds a face. This is the case the report calls out: under the rev 2 f32
// wire the solved coordinates came back quantized to ~1.2e-4 at this
// magnitude, above OCCT's 1e-7 confusion, and the arc/line joints missed each
// other. Measured on this exact geometry, quantizing the solved params to f32
// (what rev 2 delivered) drops the area builder from one surface to zero; the
// f64 wire leaves the solved joints below OCCT's confusion.
//
// Skips whenever the sketch solver, the topology builder or opencascade.js is
// absent (fresh checkout without `just wasm` / `just install-occ`).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { lowerSketch } from '@/wasm-kernel/lowerSketch'
import { encodeInput, decodeOutput } from '@/wasm-kernel/codec'
import { enrichSketchEntity } from '../../features/postRegister'
import { detectTopology, topologyAvailable } from '../../topologyTestUtil'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { sketchLoopsToFace } from '../prismLineage'
import { faceArea, wireVertexCount } from '../primitives'
import type { OccModule } from '../occTypes'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'

const bytes = loadSolver()
const oc = await loadOcc()

const XY_PLANE: PlaneLike = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, 1, 0],
  normal: [0, 0, 1],
}

// Arc centred at (1500, 0.125), r = 1499.7, from its top (1500, 1499.825,
// angle 90) round to the left side (angle 180). The tangent point sits exactly
// at x = 1500. The line leaves the top horizontally, runs out to Q and a second
// line closes Q back onto the arc's far end. Every joint is at a
// non-f32-representable coordinate, so a 32-bit output readout shows up as a
// joint gap instead of cancelling out.
const CX = 1500
const CY = 0.125
const R = 1499.7
const P: [number, number] = [CX, CY + R]
const A: [number, number] = [CX - R, CY]
const Q: [number, number] = [CX + 1000, CY + R]

const sketch = {
  id: 'sk',
  entities: [
    { id: 'arc1', kind: 'arc' },
    { id: 'l1', kind: 'line' },
    { id: 'l2', kind: 'line' },
  ],
  initial: {
    arc1: [CX, CY, R, 90, 180],
    l1: [P[0] + 1e-4, P[1] - 5e-5, Q[0] + 3e-4, Q[1] + 2e-4],
    l2: [Q[0] + 3e-4, Q[1] + 2e-4, A[0] - 1e-4, A[1] + 5e-5],
  },
  constraints: [
    { kind: 'coincident', a: { entity: 'l1', point: 'start' }, b: { entity: 'arc1', point: 'start' } },
    { kind: 'tangent', line: { entity: 'l1' }, arc: { entity: 'arc1' } },
    { kind: 'length', target: { entity: 'l1' }, value: 1000 },
    { kind: 'coincident', a: { entity: 'l1', point: 'end' }, b: { entity: 'l2', point: 'start' } },
    { kind: 'coincident', a: { entity: 'l2', point: 'end' }, b: { entity: 'arc1', point: 'end' } },
  ],
  // The arc is reference geometry for this reproduction: pin it so the solve is
  // a pure line/tangency problem at the reported coordinates.
  pinnedEntityIds: ['arc1'],
}

function solveTangentProfile(): Record<string, number[]> {
  const { input, layout } = lowerSketch(sketch)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) {
    if (l.id in sketch.initial) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  }
  solved['_residual'] = [out.diagnostics.residualNorm]
  return solved
}

describe.skipIf(!bytes || !topologyAvailable || !oc)('line tangent to an arc at x=1500 (real solver + OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  it('solves the tangent joint below OCCT confusion', () => {
    const solved = solveTangentProfile()
    // The LM residual itself reaches f64 precision on this system.
    expect(solved._residual[0]).toBeLessThan(1e-9)
    // Arc endpoint at angle 90: (1500, 1499.825) in f64.
    const arcStart: [number, number] = [
      solved.arc1[0] + solved.arc1[2] * Math.cos((solved.arc1[3] * Math.PI) / 180),
      solved.arc1[1] + solved.arc1[2] * Math.sin((solved.arc1[3] * Math.PI) / 180),
    ]
    const gap = Math.hypot(solved.l1[0] - arcStart[0], solved.l1[1] - arcStart[1])
    // Under the f32 wire this read ~1e-4, at the topology builder's merge
    // tolerance (1e-5) and far above OCC's 1e-7 confusion.
    expect(gap).toBeLessThan(1e-7)
  })

  it('builds a closed OCC wire and a face from the solved loop', () => {
    const solved = solveTangentProfile()
    const rich = {
      arc1: enrichSketchEntity('arc', solved.arc1),
      l1: enrichSketchEntity('line', solved.l1),
      l2: enrichSketchEntity('line', solved.l2),
    }
    const topo = detectTopology(rich, 'sk')
    // Rev 2's f32 readout of this same solve builds zero surfaces: the
    // quantized joints miss the 1e-5 vertex merge and the loop tears open.
    expect(topo.surfaces).toHaveLength(1)
    const boundary = topo.surfaces[0].boundary as LoopEdge[]
    expect(boundary).toHaveLength(3)

    const scope = new DisposeScope()
    try {
      // Throws unless makeWire can close the chain within OCC's confusion.
      const face = scope.track(sketchLoopsToFace(occ, scope, [boundary], XY_PLANE))
      const outer = scope.track(occ.BRepTools.OuterWire(face))
      expect(wireVertexCount(occ, scope, outer)).toBe(3)
      // A real planar face, not a degenerate sliver.
      expect(faceArea(occ, scope, face)).toBeGreaterThan(1e5)
    } finally {
      scope.dispose()
    }
  })
})
