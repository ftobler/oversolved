// @vitest-environment node
//
// Real-OCC guard for the fit-spline chain edge: the Ex010 profile (three lines
// plus one interpolating spline) extrudes to CadQuery's measured volume, and
// the spline edge is one C2 B-spline, not a chord. Skips when opencascade.js is
// absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../booleans'
import { extrudeProfileWithLineage } from '../prismLineage'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import { interpolateFitSpline } from '@/utils/geometry/fitSpline'

const oc = await loadOcc()

const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

const EX010: [number, number][] = [
  [3, 1],
  [2.75, 1.5],
  [2.5, 1.75],
  [2, 1.5],
  [1.5, 1],
  [1, 1.25],
  [0.5, 1],
  [0, 1],
]

describe.skipIf(!oc)('fit spline chain edge (real OCC)', () => {
  it('extrudes the Ex010 profile to CadQuery volume', () => {
    const scope = new DisposeScope()
    const curve = interpolateFitSpline(EX010)
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [3, 0] },
      { kind: 'line', start: [3, 0], end: [3, 1] },
      { kind: 'fit_spline', start: [3, 1], end: [0, 1], poles: curve.poles(), knots: [...curve.knots] },
      { kind: 'line', start: [0, 1], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 0.5, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // CadQuery 2.8.0: 1.8925830470835936. OCC's own volume integration on the
    // same B-spline is deterministic, so a chord (which would be a different
    // area) fails well outside this window.
    expect(vol).toBeCloseTo(1.8925830470835936, 6)
    scope.dispose()
  })

  it('a fit-spline profile is not the chord approximation', () => {
    const scope = new DisposeScope()
    const curve = interpolateFitSpline(EX010)
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [3, 0] },
      { kind: 'line', start: [3, 0], end: [3, 1] },
      { kind: 'fit_spline', start: [3, 1], end: [0, 1], poles: curve.poles(), knots: [...curve.knots] },
      { kind: 'line', start: [0, 1], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 0.5, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // The straight chord from (3,1) to (0,1) gives exactly 1.5; the bulged
    // curve is far above it.
    expect(Math.abs(vol - 1.5)).toBeGreaterThan(0.3)
    scope.dispose()
  })
})
