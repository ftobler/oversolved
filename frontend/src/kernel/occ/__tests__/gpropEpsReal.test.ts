// @vitest-environment node
//
// The adaptive BRepGProp reads. OCCT 7.4.0p1 declares a second overload of
// VolumeProperties and SurfaceProperties that takes a relative accuracy and
// returns the achieved error estimate. opencascade.js 1.1.1 exports them as
// _2, but the binding strips the C++ parameter names; this file probes the
// argument order before the shared read in occ/volume.ts relies on it.
//
// Skips when OCC.js is absent, like the other *Real suites. The timing cases
// run only with GPROP_EPS_TIMING=1 so the gate stays fast.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { DisposeScope } from '../disposeScope'
import { makeBox } from '../primitives'
import { volumeForMeasure, volumeOf } from '../volume'
import { makeTranslationTrsf, transformCopy } from '../transforms'
import { applyFilletWithDiff } from '../edgeModifier'
import { canonicalEdges } from '../bodyNames'
import { extrudeProfileWithLineage } from '../prismLineage'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { interpolateFitSpline } from '@/utils/geometry/fitSpline'
import { GPROP_EPS, TOL_VOLUME_SUM } from '../../solverConstants'
import type { BuildResponse } from '../../builder'
import type { OccGProps, OccModule, OccShape } from '../occTypes'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import { analyticHoleRemoval, splineTrimDoc } from './splineTrimBody'

const oc = await loadOcc()
const solveBytes = loadSolver()

describe.skipIf(!oc)('BRepGProp eps overloads (real OCC)', () => {
  const occ = oc as OccModule

  it('VolumeProperties_2 integrates a unit box to 1 within the requested eps', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 1, 1, 1)
      const props = scope.track(new occ.GProp_GProps_1())
      const estimate = occ.BRepGProp.VolumeProperties_2(box, props, 1e-9, true, false)
      expect(props.Mass()).toBeCloseTo(1, 12)
      expect(Number.isFinite(estimate)).toBe(true)
      expect(estimate).toBeLessThanOrEqual(1e-9)
    } finally {
      scope.dispose()
    }
  })

  it('SurfaceProperties_2 integrates a unit box to 6 within the requested eps', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 1, 1, 1)
      const props = scope.track(new occ.GProp_GProps_1())
      const estimate = occ.BRepGProp.SurfaceProperties_2(box, props, 1e-9, false)
      expect(props.Mass()).toBeCloseTo(6, 12)
      expect(Number.isFinite(estimate)).toBe(true)
      expect(estimate).toBeLessThanOrEqual(1e-9)
    } finally {
      scope.dispose()
    }
  })
})

// The probe that decided which adaptive rule each read uses. The eps overload
// is wrong on a BSPLINE *surface*: it reads the lateral face of this
// fitted-spline extrusion 6.7% high, while the GK overload lands on the
// analytic extrusion volume (profile area times height) and the default rule
// is already within 3e-5. Decisions take eps, reported volumes take GK.
describe.skipIf(!oc)('the adaptive rules on a BSPLINE surface (real OCC)', () => {
  const occ = oc as OccModule
  const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
  const EX010: [number, number][] = [
    [3, 1], [2.75, 1.5], [2.5, 1.75], [2, 1.5], [1.5, 1], [1, 1.25], [0.5, 1], [0, 1],
  ]

  // The exact volume: the profile area (bottom edge plus the integral under
  // the fitted curve) times the 0.5 extrusion height, by dense quadrature.
  function analyticExtrudeVolume(): number {
    const curve = interpolateFitSpline(EX010)
    const lastU = curve.knots[curve.knots.length - 1]
    const n = 200_000
    let area = 0
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n) * lastU
      const p = curve.eval(u)
      const d = curve.deriv(u)
      area += p[1] * -d[0] * (lastU / n)
    }
    return area * 0.5
  }

  it('GPROP_EPS via GK matches the analytic volume; the eps overload does not', () => {
    const scope = new DisposeScope()
    try {
      const curve = interpolateFitSpline(EX010)
      const loop: LoopEdge[] = [
        { kind: 'line', start: [0, 0], end: [3, 0] },
        { kind: 'line', start: [3, 0], end: [3, 1] },
        { kind: 'fit_spline', start: [3, 1], end: [0, 1], poles: curve.poles(), knots: [...curve.knots] },
        { kind: 'line', start: [0, 1], end: [0, 0] },
      ]
      const { solid } = extrudeProfileWithLineage(occ, scope, [loop], XY, [0, 0, 1], 0.5, 'sk')
      const exact = analyticExtrudeVolume()

      const shared = volumeForMeasure(occ, scope, solid)
      expect(Math.abs(shared - exact)).toBeLessThanOrEqual(1e-9 * exact)

      const epsProps = scope.track(new occ.GProp_GProps_1())
      occ.BRepGProp.VolumeProperties_2(solid, epsProps, GPROP_EPS, true, false)
      // A named regression, not a budget: the eps rule's own error estimate
      // says ~1e-16 while it is 0.6% high on this face.
      expect(epsProps.Mass() - exact).toBeGreaterThan(0.005)
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!oc || !solveBytes)('the shared volume read on a spline-trimmed face (real OCC)', () => {
  const occ = oc as OccModule
  const h = new SharedHarness(occ)

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })

  function shapeOf(r: BuildResponse, featureId: string, bodyId: string): OccShape {
    const ckp = r._build_state!.checkpoints[featureId]
    return h.table.get<OccShape>(ckp.body_store_snapshot[bodyId].shape!)
  }

  function bodyVolume(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try {
      return Math.abs(volumeOf(occ, scope, shapeOf(r, featureId, bodyId)))
    } finally {
      scope.dispose()
    }
  }

  it('reads the blind hole\'s removal to 1e-7 of the body', () => {
    const r = h.run(splineTrimDoc(1))
    expect(h.res(r, 'rev1').status).toBe('ok')
    expect(h.res(r, 'ho1').status).toBe('ok')
    const before = bodyVolume(r, 'rev1', 'body_ex1')
    const after = bodyVolume(r, 'ho1', 'body_ex1')
    const removed = before - after
    const analytic = analyticHoleRemoval(1)
    // The default rule was 0.0446 (8.6e-7 of the body) off here; the plan's
    // larger resin-mold part was 0.111 off. The eps read is what fixes both.
    expect(Math.abs(removed - analytic)).toBeLessThanOrEqual(1e-7 * after)
  }, 120_000)

  it('splits symmetrically through the trim and the halves add up', () => {
    const r = h.run(splineTrimDoc(1, true))
    const res = h.res(r, 'sp1')
    expect(res.status, String(res.exception ?? '')).toBe('ok')
    const ids = (res.body_ids ?? []) as string[]
    expect(ids).toHaveLength(2)
    const source = bodyVolume(r, 'ho1', 'body_ex1')
    const halves = ids.map((id) => bodyVolume(r, 'sp1', id))
    // The body is mirror symmetric about x = 0, so the two halves are the same
    // material; the eps read has to resolve that to its own target.
    expect(Math.abs(halves[0] - halves[1])).toBeLessThanOrEqual(GPROP_EPS * source)
    expect(Math.abs(halves[0] + halves[1] - source)).toBeLessThanOrEqual(TOL_VOLUME_SUM * source)
  }, 180_000)
})

// Step 2 of the plan: how much the adaptive rule costs, on the shapes the
// shared read is paid on. Opt-in so the gate stays fast; the numbers land in
// tmp/kb-gprop-eps-volume.md and decide between 1e-9 and 1e-8.
const timing = process.env.GPROP_EPS_TIMING === '1'

describe.runIf(!!oc && !!solveBytes && timing)('GPROP_EPS timing (real OCC)', () => {
  const occ = oc as OccModule
  const h = new SharedHarness(occ)

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })

  function volumeWith(shape: OccShape, on: (box: OccShape, props: OccGProps) => unknown): number {
    const scope = new DisposeScope()
    try {
      const props = scope.track(new occ.GProp_GProps_1())
      on(shape, props)
      return props.Mass()
    } finally {
      scope.dispose()
    }
  }

  function defaultVolume(shape: OccShape): number {
    return volumeWith(shape, (s, p) => occ.BRepGProp.VolumeProperties_1(s, p, true, false, false))
  }

  function epsVolume(shape: OccShape): number {
    return volumeWith(shape, (s, p) => occ.BRepGProp.VolumeProperties_2(s, p, GPROP_EPS, true, false))
  }

  function gkVolume(shape: OccShape): number {
    return volumeWith(shape, (s, p) => occ.BRepGProp.VolumePropertiesGK_1(s, p, GPROP_EPS, true, false, false, false, false))
  }

  function bestOf(fn: () => void, reps = 5): number {
    fn()
    let best = Infinity
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now()
      fn()
      best = Math.min(best, performance.now() - t0)
    }
    return best
  }

  function report(name: string, shapes: OccShape[]): void {
    const defaultMs = bestOf(() => { for (const s of shapes) defaultVolume(s) })
    const epsMs = bestOf(() => { for (const s of shapes) epsVolume(s) })
    const gkMs = bestOf(() => { for (const s of shapes) gkVolume(s) })
    const v0 = shapes.reduce((sum, s) => sum + defaultVolume(s), 0)
    const v1 = shapes.reduce((sum, s) => sum + epsVolume(s), 0)
    const v2 = shapes.reduce((sum, s) => sum + gkVolume(s), 0)
    console.log(
      `[gprop timings] ${name}: default ${defaultMs.toFixed(1)} ms, eps ${epsMs.toFixed(1)} ms ` +
      `(x${(epsMs / defaultMs).toFixed(2)}), GK ${gkMs.toFixed(1)} ms (x${(gkMs / defaultMs).toFixed(2)}), ` +
      `volume default/eps/GK ${v0.toFixed(6)} / ${v1.toFixed(6)} / ${v2.toFixed(6)}`,
    )
  }

  it('measures the four cases', () => {
    const r = h.run(splineTrimDoc(1))
    expect(h.res(r, 'ho1').status).toBe('ok')
    const ckp = r._build_state!.checkpoints['ho1']
    const body = h.table.get<OccShape>(ckp.body_store_snapshot['body_ex1'].shape!)
    report('centre-hole body', [body])

    const scope = new DisposeScope()
    try {
      const copies: OccShape[] = []
      for (let i = 0; i < 32; i++) {
        const dx = (i % 8) * 150
        const dy = Math.floor(i / 8) * 60
        copies.push(scope.track(transformCopy(occ, scope, body, makeTranslationTrsf(occ, scope, dx, dy, 0))))
      }
      report('32-copy body pattern', copies)
      report('translated centre-hole body', [copies[31]])

      const box = scope.track(makeBox(occ, scope, 60, 40, 20))
      const filleted = applyFilletWithDiff(occ, scope, box, 2, canonicalEdges(occ, scope, box))
      expect(filleted.success).toBe(true)
      report('filleted box', [scope.track(filleted.shape)])
    } finally {
      scope.dispose()
    }
  }, 300_000)
})
