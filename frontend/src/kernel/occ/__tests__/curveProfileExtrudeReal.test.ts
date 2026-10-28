// @vitest-environment node
//
// Real-OCC guard: a sketch profile whose boundary includes a spline or a full
// ellipse extrudes into a valid solid (sketch area builder -> curved profile
// wire -> prism). The boundary edges must be built as true curved OCC edges
// (bezier / ellipse), not straight chords. Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../booleans'
import { extrudeProfileWithLineage } from '../prismLineage'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import { handlesFromTangents, interpolateFitSpline } from '@/utils/geometry/fitSpline'

const oc = await loadOcc()

// XY sketch plane extruded along +Z.
const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

describe.skipIf(!oc)('curved profile extrude (real OCC)', () => {
  it('extrudes a full-ellipse profile to a solid', () => {
    const scope = new DisposeScope()
    const loop: LoopEdge[] = [{ kind: 'ellipse', center: [0, 0], a: 4, b: 2, theta: 0 }]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 5, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // pi*a*b*h = pi*4*2*5 ~= 125.66; assert it is near that, not the bbox.
    expect(vol).toBeGreaterThan(120)
    expect(vol).toBeLessThan(131)
    scope.dispose()
  })

  it('extrudes a self-closing spline (single closed Bezier loop) to a solid', () => {
    const scope = new DisposeScope()
    // Teardrop: one spline whose start and end both sit on the origin. The whole
    // area is bounded by a single closed Bezier edge (no chord, no other edge).
    const loop: LoopEdge[] = [
      { kind: 'spline', start: [0, 0], c1: [4, 4], c2: [-4, 4], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 2, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    expect(vol).toBeGreaterThan(1)
    scope.dispose()
  })

  it('extrudes the tan2pt fit-spline profile with CadQuery scaling', () => {
    const scope = new DisposeScope()
    const points: [number, number][] = [[2, 0], [3, 2]]
    const handles = handlesFromTangents(points, [[0, 1], [-1, 1]], true)
    const curve = interpolateFitSpline(points, handles.handleStart, handles.handleEnd)
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [2, 0] },
      { kind: 'fit_spline', start: [2, 0], end: [3, 2], poles: curve.poles(), knots: [...curve.knots] },
      { kind: 'line', start: [3, 2], end: [0, 2] },
      { kind: 'line', start: [0, 2], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 1, 'sk')
    expect(volumeOf(oc!, scope, solid)).toBeCloseTo(5.074999999999999, 5)
    scope.dispose()
  })

  it('extrudes the tan2pt profile with scale=False', () => {
    const scope = new DisposeScope()
    const points: [number, number][] = [[2, 0], [3, 2]]
    const handles = handlesFromTangents(points, [[0, 1], [-1, 1]], false)
    const curve = interpolateFitSpline(points, handles.handleStart, handles.handleEnd)
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [2, 0] },
      { kind: 'fit_spline', start: [2, 0], end: [3, 2], poles: curve.poles(), knots: [...curve.knots] },
      { kind: 'line', start: [3, 2], end: [0, 2] },
      { kind: 'line', start: [0, 2], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 1, 'sk')
    expect(volumeOf(oc!, scope, solid)).toBeCloseTo(5.363880262166624, 5)
    scope.dispose()
  })

  it('extrudes the tan4pt profile with CadQuery scaling', () => {
    const scope = new DisposeScope()
    const points: [number, number][] = [[3, 0], [3.5, 1], [3, 2], [3.4, 3]]
    const handles = handlesFromTangents(points, [[1, 1], [0, 1]], true)
    const curve = interpolateFitSpline(points, handles.handleStart, handles.handleEnd)
    const loop: LoopEdge[] = [
      { kind: 'line', start: [0, 0], end: [3, 0] },
      { kind: 'fit_spline', start: [3, 0], end: [3.4, 3], poles: curve.poles(), knots: [...curve.knots] },
      { kind: 'line', start: [3.4, 3], end: [0, 3] },
      { kind: 'line', start: [0, 3], end: [0, 0] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 1, 'sk')
    expect(volumeOf(oc!, scope, solid)).toBeCloseTo(9.911651440844567, 5)
    scope.dispose()
  })

  it('refuses an unknown loop edge kind instead of drawing a chord', () => {
    const scope = new DisposeScope()
    const loop: LoopEdge[] = [{ kind: 'blob', start: [0, 0], end: [1, 0] }]
    expect(() => extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 1, 'sk'))
      .toThrow(/unknown loop edge kind 'blob'/)
    scope.dispose()
  })

  it('extrudes a D-shape (line + spline) profile to a solid', () => {
    const scope = new DisposeScope()
    // base line A->B, spline B->A bulging up: a closed half-disc-ish area.
    const A = [0, 0]
    const B = [4, 0]
    const loop: LoopEdge[] = [
      { kind: 'line', start: A, end: B },
      { kind: 'spline', start: B, end: A, c1: [3, 3], c2: [1, 3] },
    ]
    const { solid } = extrudeProfileWithLineage(oc!, scope, [loop], XY, [0, 0, 1], 2, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // The bulged area is clearly positive; a chord approximation would give a
    // different (smaller, triangle-ish) volume, but any valid solid is > 0.
    expect(vol).toBeGreaterThan(1)
    scope.dispose()
  })
})
