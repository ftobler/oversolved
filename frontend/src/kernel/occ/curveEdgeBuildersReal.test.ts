// @vitest-environment node
//
// Real-OCC guard for the bezier + ellipse edge builders that let a sketch
// profile carry spline / full-ellipse boundary edges (sketch area builder ->
// extrude). Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { makeBezierEdge, makeEllipseEdge, edgeToGeom } from './primitives'

const oc = await loadOcc()

describe.skipIf(!oc)('curve edge builders (real OCC)', () => {
  it('makeBezierEdge builds a curved edge through its end poles', () => {
    const scope = new DisposeScope()
    const e = makeBezierEdge(oc!, scope, [[0, 0, 0], [1, 3, 0], [4, 3, 0], [5, 0, 0]])
    const { ed } = edgeToGeom(oc!, scope, e)
    // A cubic Bezier is not a line/circle, so the reader samples it as a spline.
    expect(ed.kind).toBe('spline')
    const pts = (ed as { points: number[][] }).points
    expect(pts[0][0]).toBeCloseTo(0)  // P1
    expect(pts[0][1]).toBeCloseTo(0)
    expect(pts[pts.length - 1][0]).toBeCloseTo(5)  // P4
    expect(pts[pts.length - 1][1]).toBeCloseTo(0)
    scope.dispose()
  })

  it('makeEllipseEdge builds a full ellipse with the given semi-axes', () => {
    const scope = new DisposeScope()
    const e = makeEllipseEdge(oc!, scope, [1, 2, 0], [0, 0, 1], [1, 0, 0], 4, 2)
    const { ed } = edgeToGeom(oc!, scope, e)
    expect(ed.kind).toBe('ellipse')
    const el = ed as { center: number[]; a: number; b: number }
    expect(el.center[0]).toBeCloseTo(1)
    expect(el.center[1]).toBeCloseTo(2)
    expect(el.a).toBeCloseTo(4)
    expect(el.b).toBeCloseTo(2)
    scope.dispose()
  })
})
