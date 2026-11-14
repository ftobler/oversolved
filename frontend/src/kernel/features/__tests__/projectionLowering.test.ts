// Pure projection lowering: resolve a source payload to 3D, project to 2D
// entity params on a sketch plane. Covers all edge kinds the OCC reader emits
// plus the orientation-aware circle -> ellipse promotion (full-brep-projection).
import { describe, it, expect } from 'vitest'
import {
  resolve3dGeometry,
  projectTo2d,
  projectCenter,
  circleToEllipseParams,
  type PlaneFrame,
  type Resolved3dGeometry,
} from '../projectionLowering'
import {
  curveScale,
  maxDeviationToCubic,
  maxDeviationToFitSpline,
  PROJECTED_CURVE_FIT_TOL,
} from '@/utils/geometry/projectedCurveFit'
import { interpolateFitSpline, type Pt } from '@/utils/geometry/fitSpline'
import { fitCubicBezier } from '@/utils/geometry/bezierFit'
import { cross } from '@/utils/vec3'
import { worldToSketch2d } from '../shared/planes'

// XY sketch plane: normal = +Z.
const XY: PlaneFrame = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }

describe('resolve3dGeometry', () => {
  it('reads a flat x/y/z vertex payload as a point', () => {
    const g = resolve3dGeometry({ type: 'vertex', x: 1, y: 2, z: 3 })
    expect(g).toEqual({ kindH: 'point', data: { point: [1, 2, 3] } })
  })

  it('reads a B-rep vertex payload (coords under `origin`) as a point', () => {
    // builder.ts registers B-rep vertices with `origin: [x,y,z]`, no flat keys.
    // Regression: this used to fall through to [0,0,0] and project the document
    // origin, so every picked B-rep vertex landed 100% wrong.
    const g = resolve3dGeometry(
      { type: 'vertex', body_id: 'b1', vertex_index: 2, origin: [5, -3, 7] })
    expect(g).toEqual({ kindH: 'point', data: { point: [5, -3, 7] } })
  })

  it('reads a line edge', () => {
    const g = resolve3dGeometry({ type: 'edge', kind: 'line', start: [0, 0, 0], end: [4, 0, 0] })
    expect(g).toEqual({ kindH: 'line', data: { start: [0, 0, 0], end: [4, 0, 0] } })
  })

  it('carries circle axis/x_axis through for orientation detection', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0] })
    expect(g?.kindH).toBe('circle')
    expect(g?.data.axis).toEqual([0, 0, 1])
  })

  it('reads an ellipse edge', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'ellipse', center: [1, 2, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] })
    expect(g?.kindH).toBe('ellipse')
    expect(g?.data).toMatchObject({ center: [1, 2, 0], a: 4, b: 2 })
  })

  it('reads a sampled spline edge', () => {
    const pts = [[0, 0, 0], [1, 1, 0], [2, 0, 0]]
    const g = resolve3dGeometry({ type: 'edge', kind: 'spline', points: pts })
    expect(g).toEqual({ kindH: 'spline', data: { points: pts } })
  })

  it('rejects an ellipse edge missing semi-axes', () => {
    expect(resolve3dGeometry({ type: 'edge', kind: 'ellipse', center: [0, 0, 0] })).toBeNull()
  })

  it('reads a face payload as its centroid point', () => {
    // A picked face projects to a point at its centroid; `origin` is the
    // fallback when no centroid was stamped.
    expect(resolve3dGeometry({ type: 'flatface', centroid: [1, 2, 3], origin: [9, 9, 9] }))
      .toEqual({ kindH: 'point', data: { point: [1, 2, 3] } })
    expect(resolve3dGeometry({ type: 'cylinderface', origin: [4, 5, 6] }))
      .toEqual({ kindH: 'point', data: { point: [4, 5, 6] } })
    expect(resolve3dGeometry({ type: 'face' }))
      .toEqual({ kindH: 'point', data: { point: [0, 0, 0] } })
  })

  it('reads every face kind, not just the flat and cylindrical ones', () => {
    // A countersink cone (or a sphere/torus) face picked for projection used
    // to fall past this branch and project nothing at all.
    for (const type of ['coneface', 'sphereface', 'torusface']) {
      expect(resolve3dGeometry({ type, centroid: [7, 8, 9] }))
        .toEqual({ kindH: 'point', data: { point: [7, 8, 9] } })
    }
  })

  it('reads a slash-registry point (flat x/y/z, no type) as a point', () => {
    // Hole/point payloads from the slash registry carry bare x/y/z and no
    // `type`; the B-rep vertex arm does not match them, so the fallback must.
    expect(resolve3dGeometry({ x: 1, y: 2, z: 3 }))
      .toEqual({ kindH: 'point', data: { point: [1, 2, 3] } })
    expect(resolve3dGeometry({ y: 2 }))
      .toEqual({ kindH: 'point', data: { point: [0, 2, 0] } })
  })

  it('falls back to a bare origin payload as a point', () => {
    expect(resolve3dGeometry({ origin: [4, 5, 6] }))
      .toEqual({ kindH: 'point', data: { point: [4, 5, 6] } })
  })

  it('returns null for a payload with no geometry it understands', () => {
    expect(resolve3dGeometry({ type: 'unknown' })).toBeNull()
  })
})

describe('projectTo2d basic kinds', () => {
  it('point', () => {
    const g: Resolved3dGeometry = { kindH: 'point', data: { point: [3, 4, 9] } }
    expect(projectTo2d(g, XY)).toEqual({ kind: 'point', params: [3, 4] })
  })

  it('line', () => {
    const g: Resolved3dGeometry = { kindH: 'line', data: { start: [0, 0, 5], end: [4, 2, 5] } }
    expect(projectTo2d(g, XY)).toEqual({ kind: 'line', params: [0, 0, 4, 2] })
  })
})

describe('end-on line projection', () => {
  // A straight source perpendicular to the sketch plane projects to a
  // zero-length segment, which is not geometry: it has no direction, so
  // `horizontal`, `parallel` and `angle` on it mean nothing and the area
  // builder has to survive it. Its true projection is the one point both ends
  // land on.

  it('1. a line along +Z projects as its midpoint point', () => {
    const g: Resolved3dGeometry = { kindH: 'line', data: { start: [3, 4, -2], end: [3, 4, 9] } }
    expect(projectTo2d(g, XY)).toEqual({ kind: 'point', params: [3, 4] })
  })

  it('2. collapses on the projected width, not the source angle', () => {
    // One lateral offset on a line 10 long: the 1e-6 lift projects below the
    // merge rung and collapses, the 1e-3 lift is above it and the line stays a
    // real segment of that length.
    const leaning = (offset: number): Resolved3dGeometry => ({
      kindH: 'line', data: { start: [2, 3, -4], end: [2 + offset, 3, 6] },
    })
    const collapsed = projectTo2d(leaning(1e-6), XY)!
    expect(collapsed.kind).toBe('point')
    // The midpoint of the two ends, so neither source end is privileged.
    expect(collapsed.params[0]).toBeCloseTo(2 + 5e-7, 9)
    expect(collapsed.params[1]).toBeCloseTo(3, 9)

    const kept = projectTo2d(leaning(1e-3), XY)!
    expect(kept.kind).toBe('line')
    expect(kept.params).toEqual([2, 3, 2 + 1e-3, 3])

    // The opposite separation, so the classification cannot be an angle rule:
    // a line only 1e-5 long but laid at 45 degrees to the plane projects
    // 7.07e-6, under the rung, and collapses. A rule keyed on the tilt keeps
    // it, because 45 degrees is nowhere near perpendicular.
    const steep = projectTo2d({
      kindH: 'line',
      data: { start: [2, 3, 0], end: [2 + 1e-5 / Math.SQRT2, 3, 1e-5 / Math.SQRT2] },
    }, XY)!
    expect(steep.kind).toBe('point')
    expect(steep.params[0]).toBeCloseTo(2 + 1e-5 / (2 * Math.SQRT2), 9)
    expect(steep.params[1]).toBeCloseTo(3, 9)
  })

  it('3. a foreign sketch line lifted through a perpendicular frame becomes a point', () => {
    // The source sketch sits on Right, whose local x runs along world -Z, so a
    // line across that axis is perpendicular to the Front (XY) target plane.
    // The foreign line travels through `external_params`, the lift every
    // cross-sketch projection takes.
    const right = { origin: [0, 0, 0], x_axis: [0, 0, -1], y_axis: [0, 1, 0], normal: [1, 0, 0] }
    const g = resolve3dGeometry(
      { external_params: [1, 2, 7, 2], kind: 'line', sketch_id: 'sk1' },
      (sketchId) => (sketchId === 'sk1' ? right : null),
    )!
    expect(projectTo2d(g, XY)).toEqual({ kind: 'point', params: [0, 2] })
  })
})

describe('orientation-aware circle projection', () => {
  it('a circle parallel to the sketch plane stays a circle', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [1, 2, 7], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0] })!
    const out = projectTo2d(g, XY)
    expect(out?.kind).toBe('circle')
    expect(out?.params).toEqual([1, 2, 5])
  })

  it('a circle tilted 60 deg about X projects to an ellipse (a=R, b=R cos60)', () => {
    const phi = Math.PI / 3  // 60 degrees
    // Circle plane normal tilted off +Z by phi about the X axis.
    const axis = [0, -Math.sin(phi), Math.cos(phi)]
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5, axis, x_axis: [1, 0, 0] })!
    const out = projectTo2d(g, XY)
    expect(out?.kind).toBe('ellipse')
    const [cx, cy, a, b, theta] = out!.params
    expect(cx).toBeCloseTo(0)
    expect(cy).toBeCloseTo(0)
    expect(a).toBeCloseTo(5)
    expect(b).toBeCloseTo(5 * Math.cos(phi))  // 2.5
    expect(theta).toBeCloseTo(0)
  })

  it('circleToEllipseParams matches the manual conjugate-diameter result', () => {
    const phi = Math.PI / 4
    const axis = [0, -Math.sin(phi), Math.cos(phi)]
    const [, , a, b] = circleToEllipseParams([0, 0, 0], 3, axis, [1, 0, 0], XY)
    expect(a).toBeCloseTo(3)
    expect(b).toBeCloseTo(3 * Math.cos(phi))
  })
})

describe('ellipse edge projection', () => {
  it('an in-plane ellipse projects to its own params', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] })!
    const out = projectTo2d(g, XY)
    expect(out?.kind).toBe('ellipse')
    const [cx, cy, a, b, theta] = out!.params
    expect(cx).toBeCloseTo(0)
    expect(cy).toBeCloseTo(0)
    expect(a).toBeCloseTo(4)
    expect(b).toBeCloseTo(2)
    expect(theta).toBeCloseTo(0)
  })

  it('a partial elliptical arc projects as a fitted spline (no 2D ellipse-arc entity)', () => {
    // A quarter of this eccentric ellipse misses one cubic by 2.9e-3 of its
    // size, over the 1.5e-3 rung, so it lowers to the interpolating spline.
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
        axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('fit_spline')
    const p = out.params
    // Fit-point block, both endpoints exact to f64: the fit points ARE the
    // projected source ends, t=0 -> [4,0], t=pi/2 -> [4 cos(pi/2), 2].
    expect(p.length).toBeGreaterThan(8)
    expect(p[0]).toBe(4)
    expect(p[1]).toBe(0)
    expect(p[p.length - 2]).toBe(4 * Math.cos(Math.PI / 2))
    expect(p[p.length - 1]).toBe(2)
  })

  it('a rotated in-plane ellipse reports its rotation', () => {
    // Major axis along the 2D 45 deg direction.
    const x_axis = [Math.SQRT1_2, Math.SQRT1_2, 0]
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis })!
    const out = projectTo2d(g, XY)!
    const [, , a, b, theta] = out.params
    expect(a).toBeCloseTo(4)
    expect(b).toBeCloseTo(2)
    expect(Math.abs(theta)).toBeCloseTo(45)
  })
})

describe('arc projection (3D body arc)', () => {
  it('projects a quarter arc on the XY plane to 2D DEGREE angles', () => {
    // Regression: the lowering emitted raw atan2 RADIANS into the degree-
    // convention angle slots, so even a coplanar quarter circle pinned at a
    // ~1.57 degree sweep once it reached the solver or any consumer.
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('arc')
    const [cx, cy, r, sa, ea] = out.params
    expect(cx).toBeCloseTo(0)
    expect(cy).toBeCloseTo(0)
    expect(r).toBeCloseTo(5)
    expect(sa).toBeCloseTo(0)
    expect(ea).toBeCloseTo(90)
    expect(Object.keys(out)).toEqual(['kind', 'params'])
  })

  it('spells an anti-parallel source axis counter-clockwise, swapping the ends', () => {
    // Mirrored projection: the source sweeps 0 -> 90 deg around -Z, which on
    // the sketch plane runs clockwise through the fourth quadrant. The sketch
    // arc entity has no winding field (the solver, the area builder and every
    // preview read a0 -> a1 counter-clockwise), so a `ccw: false` flag here
    // was dropped and the arc became its 270 degree complement. The same
    // quarter read counter-clockwise runs -90 -> 0.
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 0, -1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const out = projectTo2d(g, XY)!
    expect(Object.keys(out)).toEqual(['kind', 'params'])
    const [, , r, sa, ea] = out.params
    expect(r).toBeCloseTo(5)
    expect(sa).toBeCloseTo(-90)
    expect(ea).toBeCloseTo(0)
  })

  it('refuses an arc payload with no axis or no sweep', () => {
    // The OCC reader always writes the circle's axis/x_axis and the sketch lift
    // supplies the owning frame's normal and both angles, so a projectable arc
    // always carries its plane. An axis-less payload was reachable only from a
    // hand-built test, and its old pass-through branch mixed radian angles into
    // degree slots. postRegister's topology-edge registration is the real
    // axis-less, angle-less shape: center/radius only, refused here too.
    const axisless = resolve3dGeometry(
      { type: 'edge', kind: 'arc', center: [1, 2, 0], radius: 5, angle_start: 30, angle_end: 120 })!
    expect(axisless.kindH).toBe('arc')
    expect(projectTo2d(axisless, XY)).toBeNull()

    const topologyEdge = resolve3dGeometry(
      { type: 'edge', kind: 'arc', center: [3, 4, 0], radius: 2 })!
    expect(topologyEdge.kindH).toBe('arc')
    expect(projectTo2d(topologyEdge, XY)).toBeNull()
  })

  it('lowers a tilted source arc to a sampled curve, not a fake circular arc', () => {
    // A tilted circular arc projects to an elliptical arc; the old lowering
    // rebuilt it as a single-radius circular arc whose radius came from one
    // endpoint and whose side was arbitrary. At a 60 degree tilt the projected
    // quarter misses one cubic by 2.9e-3 of its size, over the 1.5e-3 rung, so
    // it lowers to the interpolating spline.
    const phi = Math.PI / 3
    const axis = [0, -Math.sin(phi), Math.cos(phi)]
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis, x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('fit_spline')
    const p = out.params
    expect(p.length).toBeGreaterThan(8)
    // Endpoints survive exactly to f64: t=0 -> (5,0); t=pi/2 -> y-axis of the
    // source frame is (0, cos phi, sin phi), projected to (5 cos(pi/2), 5 cos phi).
    expect(p[0]).toBe(5)
    expect(p[1]).toBe(0)
    expect(p[p.length - 2]).toBe(5 * Math.cos(Math.PI / 2))
    expect(p[p.length - 1]).toBe(5 * Math.cos(phi))
  })
})

describe('edge-on conic projection', () => {
  // Every conic seen edge-on stores a zero-width ellipse, which the area
  // builder cannot split and OCC refuses (`make_ellipse_edge: needs a >= b > 0`).
  // Its true silhouette is a real segment, so the lowerer emits that line.

  /** The line's endpoints, sorted into (min, max) per axis so either spelling
   *  of the same silhouette compares equal. */
  function line(params: number[]) {
    const [x0, y0, x1, y1] = params
    return {
      xMin: Math.min(x0, x1), xMax: Math.max(x0, x1),
      yMin: Math.min(y0, y1), yMax: Math.max(y0, y1),
      midX: (x0 + x1) / 2, midY: (y0 + y1) / 2,
      length: Math.hypot(x1 - x0, y1 - y0),
    }
  }

  it('1. a full circle seen edge-on becomes a line through its projected centre', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [1, 2, 0], radius: 3, axis: [1, 0, 0], x_axis: [0, 1, 0] })!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('line')
    expect(out.params).toHaveLength(4)
    const l = line(out.params)
    expect(l.xMin).toBeCloseTo(1)
    expect(l.xMax).toBeCloseTo(1)
    expect(l.yMin).toBeCloseTo(-1)
    expect(l.yMax).toBeCloseTo(5)
    expect(l.length).toBeCloseTo(6)
    expect(l.midX).toBeCloseTo(1)
    expect(l.midY).toBeCloseTo(2)
    // Endpoint order is canonical (left to right, or upward when vertical), so
    // the same segment spells its start/end the same way whichever side of the
    // branch cut the source's x_axis lands on.
    expect(out.params).toEqual([
      expect.closeTo(1), expect.closeTo(-1), expect.closeTo(1), expect.closeTo(5),
    ])
    const reversed = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [1, 2, 0], radius: 3, axis: [1, 0, 0], x_axis: [0, -1, 0] })!
    expect(projectTo2d(reversed, XY)!.params).toEqual([
      expect.closeTo(1), expect.closeTo(-1), expect.closeTo(1), expect.closeTo(5),
    ])
  })

  it('2. collapses on the projected WIDTH, not the tilt angle', () => {
    // The projected minor semi-axis is R*|axis.n|. These pairs separate "width"
    // from "angle": one width at very different radii and tilts classifies the
    // same, while one tilt at two radii classifies differently, so a pure angle
    // threshold cannot pass.
    const axisAtWidth = (R: number, width: number) => {
      const cosAlpha = width / R
      return [0, Math.sqrt(1 - cosAlpha * cosAlpha), cosAlpha]
    }
    const at = (R: number, width: number) => resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [0, 0, 0], radius: R, axis: axisAtWidth(R, width), x_axis: [1, 0, 0] })!

    // Same width above the rung, at a small and a 1000x larger radius/angle:
    // both stay ellipses with that width.
    for (const R of [3, 3000]) {
      const out = projectTo2d(at(R, 1e-3), XY)!
      expect(out.kind).toBe('ellipse')
      expect(out.params[3]).toBeCloseTo(1e-3, 8)
    }
    // Same width under the rung, same two angles: both collapse.
    for (const R of [3, 3000]) expect(projectTo2d(at(R, 5e-6), XY)!.kind).toBe('line')

    // One tilt, two radii: the small circle's width is under the rung and the
    // large one's is over it, so the same angle gives different answers.
    const cosAlpha = 8.5e-6
    const sameAngle = (R: number) => resolve3dGeometry(
      {
        type: 'edge', kind: 'circle', center: [0, 0, 0], radius: R,
        axis: [0, Math.sqrt(1 - cosAlpha * cosAlpha), cosAlpha], x_axis: [1, 0, 0],
      })!
    expect(projectTo2d(sameAngle(1), XY)!.kind).toBe('line')
    expect(projectTo2d(sameAngle(10), XY)!.kind).toBe('ellipse')
  })

  it('3. a full ellipse seen edge-on keeps the extent that is still in the sketch plane', () => {
    // Major axis in the sketch plane: the major extent survives.
    const inPlane = resolve3dGeometry(
      { type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [1, 0, 0], x_axis: [0, 1, 0] })!
    const l = line(projectTo2d(inPlane, XY)!.params)
    expect(projectTo2d(inPlane, XY)!.kind).toBe('line')
    expect(l.length).toBeCloseTo(8)

    // Major axis along the sketch normal: only the minor extent is left.
    const alongNormal = resolve3dGeometry(
      { type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [0, 1, 0], x_axis: [0, 0, 1] })!
    const out = projectTo2d(alongNormal, XY)!
    expect(out.kind).toBe('line')
    expect(line(out.params).length).toBeCloseTo(4)
  })

  it('4. an edge-on quarter arc is the unsplit segment between its projected ends', () => {
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 1, 0], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('line')
    const l = line(out.params)
    expect(l.xMin).toBeCloseTo(0)
    expect(l.xMax).toBeCloseTo(5)
    expect(l.yMin).toBeCloseTo(0)
    expect(l.yMax).toBeCloseTo(0)
  })

  it('5. a folding edge-on arc gives its covered extent, the interior extremum included', () => {
    // The projected sweep runs out to the extremum at t=0 and back, so a
    // sampled chord set would repeat the segment; the silhouette is the extent
    // it covers.
    const sweep = (a0: number, a1: number) => resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 1, 0], x_axis: [1, 0, 0], angle_start: a0, angle_end: a1,
      })!
    const symmetric = projectTo2d(sweep(-Math.PI / 4, Math.PI / 4), XY)!
    expect(symmetric.kind).toBe('line')
    const l = line(symmetric.params)
    expect(l.xMin).toBeCloseTo(5 * Math.cos(Math.PI / 4))
    expect(l.xMax).toBeCloseTo(5)

    // An asymmetric sweep puts the extremum between sample points: only the
    // exact extremum keeps the extent at R.
    const asymmetric = projectTo2d(sweep(-50 * Math.PI / 180, 40 * Math.PI / 180), XY)!
    const a = line(asymmetric.params)
    expect(a.xMax).toBeCloseTo(5, 6)
    expect(a.xMin).toBeCloseTo(5 * Math.cos(50 * Math.PI / 180))
  })

  it('6. an edge-on partial ellipse is a line, not a fitted spline', () => {
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
        axis: [0, 1, 0], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('line')
    const l = line(out.params)
    expect(l.xMin).toBeCloseTo(0)
    expect(l.xMax).toBeCloseTo(4)
  })

  it('7. a seam-crossing edge-on arc follows the counter-clockwise sweep', () => {
    // 270 -> 90 deg wraps once through 2*pi, so the arc covers the +x half of
    // the circle. Sampling a0 -> a1 directly would walk backwards over the
    // complement and report the wrong extent.
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 1, 0], x_axis: [1, 0, 0], angle_start: 3 * Math.PI / 2, angle_end: Math.PI / 2,
      })!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('line')
    const l = line(out.params)
    expect(l.xMin).toBeCloseTo(0)
    expect(l.xMax).toBeCloseTo(5)
  })

  it('8. a collapsed or sub-tolerance silhouette reports instead of storing a stub', () => {
    // A zero-radius circle and a zero-sweep arc project to a single point; a
    // radius or sweep under the merge rung is the same degenerate class. Storing
    // one as a line would be the entity this rule exists to remove, so the
    // lowering refuses it (a projection error upstream).
    const zeroCircle = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [1, 2, 0], radius: 0, axis: [1, 0, 0], x_axis: [0, 1, 0] })!
    expect(projectTo2d(zeroCircle, XY)).toBeNull()

    const tinyCircle = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [1, 2, 0], radius: 1e-6, axis: [1, 0, 0], x_axis: [0, 1, 0] })!
    expect(projectTo2d(tinyCircle, XY)).toBeNull()

    const zeroArc = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 1, 0], x_axis: [1, 0, 0], angle_start: Math.PI / 2, angle_end: Math.PI / 2,
      })!
    expect(projectTo2d(zeroArc, XY)).toBeNull()

    // A sweep far larger than zero but whose covered chord is still under the
    // rung is the same class: the guard must not be an exact `> 0`.
    const tinyArc = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 1, 0], x_axis: [1, 0, 0], angle_start: 0, angle_end: 1e-6,
      })!
    expect(projectTo2d(tinyArc, XY)).toBeNull()
  })

  it('9. reads the silhouette direction from the major axis, not the collapsed minor', () => {
    // Silhouette exactly along local +y. The minor semi-axis is always local +x
    // once it has collapsed under the rung, so reading the direction from it
    // measured every sample's x (0 here) and returned null.
    const yArc = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [1, 0, 0], x_axis: [0, 1, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const arcOut = projectTo2d(yArc, XY)!
    expect(arcOut.kind).toBe('line')
    const al = line(arcOut.params)
    expect(al.xMin).toBeCloseTo(0)
    expect(al.xMax).toBeCloseTo(0)
    expect(al.yMin).toBeCloseTo(0)
    expect(al.yMax).toBeCloseTo(5)

    const yPartial = resolve3dGeometry(
      {
        type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
        axis: [1, 0, 0], x_axis: [0, 1, 0], angle_start: 0, angle_end: Math.PI / 2,
      })!
    const partOut = projectTo2d(yPartial, XY)!
    expect(partOut.kind).toBe('line')
    const pl = line(partOut.params)
    expect(pl.xMin).toBeCloseTo(0)
    expect(pl.xMax).toBeCloseTo(0)
    expect(pl.yMin).toBeCloseTo(0)
    expect(pl.yMax).toBeCloseTo(4)
  })

  it('10. an oblique silhouette keeps its direction and length on every conic path', () => {
    // Plane normal at -45 in the sketch plane, major direction at +45: the
    // silhouette runs along (1,1)/sqrt2. Reading the collapsed minor measured a
    // horizontal segment of half the true length.
    const s = Math.SQRT1_2
    const frame = { axis: [s, -s, 0], x_axis: [s, s, 0] }
    const circle = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5, ...frame })!
    const circleOut = projectTo2d(circle, XY)!
    expect(circleOut.kind).toBe('line')
    expect(line(circleOut.params).length).toBeCloseTo(10)
    expect(circleOut.params[2] - circleOut.params[0]).toBeCloseTo(5 * Math.SQRT2)
    expect(circleOut.params[3] - circleOut.params[1]).toBeCloseTo(5 * Math.SQRT2)

    const arc = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5, ...frame,
        angle_start: 0, angle_end: Math.PI / 2,
      })!
    const arcOut = projectTo2d(arc, XY)!
    expect(arcOut.kind).toBe('line')
    // The quarter sweep covers half the radius along the same 45 deg line.
    expect(line(arcOut.params).length).toBeCloseTo(5)
    expect(arcOut.params[2] - arcOut.params[0]).toBeCloseTo(5 * s)
    expect(arcOut.params[3] - arcOut.params[1]).toBeCloseTo(5 * s)

    const partial = resolve3dGeometry(
      {
        type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, ...frame,
        angle_start: 0, angle_end: Math.PI / 2,
      })!
    const partOut = projectTo2d(partial, XY)!
    expect(partOut.kind).toBe('line')
    expect(line(partOut.params).length).toBeCloseTo(4)
    expect(partOut.params[2] - partOut.params[0]).toBeCloseTo(4 * s)
    expect(partOut.params[3] - partOut.params[1]).toBeCloseTo(4 * s)
  })
})

describe('projectCenter', () => {
  it('projects the centre of a circle, an arc and an ellipse in any orientation', () => {
    const circle: Resolved3dGeometry = {
      kindH: 'circle', data: { center: [1, 2, 3], radius: 5, axis: [1, 0, 0], x_axis: [0, 1, 0] },
    }
    const arc: Resolved3dGeometry = {
      kindH: 'arc',
      data: { center: [4, 5, 6], radius: 2, axis: [1, 0, 0], x_axis: [0, 1, 0], angle_start: 0, angle_end: 1 },
    }
    const ellipse: Resolved3dGeometry = {
      kindH: 'ellipse', data: { center: [-1, -2, -3], a: 4, b: 2, axis: [1, 0, 0], x_axis: [0, 1, 0] },
    }
    expect(projectCenter(circle, XY)).toEqual({ kind: 'point', params: [1, 2] })
    expect(projectCenter(arc, XY)).toEqual({ kind: 'point', params: [4, 5] })
    expect(projectCenter(ellipse, XY)).toEqual({ kind: 'point', params: [-1, -2] })
  })

  it('reads the centre through the sketch frame, not the world axes', () => {
    const right: PlaneFrame = { origin: [10, 0, 0], x_axis: [0, 0, -1], y_axis: [0, 1, 0] }
    const circle: Resolved3dGeometry = { kindH: 'circle', data: { center: [10, 2, -3], radius: 1 } }
    expect(projectCenter(circle, right)).toEqual({ kind: 'point', params: [3, 2] })
  })

  it('has no centre for a line or a spline, so the resolved kind wins', () => {
    expect(projectCenter({ kindH: 'line', data: { start: [0, 0, 0], end: [1, 1, 1] } }, XY)).toBeNull()
    expect(projectCenter({ kindH: 'spline', data: { points: [[0, 0, 0], [1, 1, 1]] } }, XY)).toBeNull()
    expect(projectCenter({ kindH: 'point', data: { point: [1, 2, 3] } }, XY)).toBeNull()
  })
})

describe('sampled curve fitting', () => {
  // A 30 degree tilt about world X, radius 5. The projected arc is an ellipse
  // with a = 5 and b = 5 cos(30) in the XY sketch frame.
  const PHI = Math.PI / 6
  const TILT_AXIS = [0, -Math.sin(PHI), Math.cos(PHI)]

  function arcEdge(a0: number, a1: number): Resolved3dGeometry {
    return resolve3dGeometry({
      type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
      axis: TILT_AXIS, x_axis: [1, 0, 0], angle_start: a0, angle_end: a1,
    })!
  }

  // The true projected arc, sampled densely: an ellipse arc of a = 5, b = 5 cos(phi).
  function arcTruth(a0: number, a1: number, steps = 128): Pt[] {
    const out: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (a1 - a0) * (i / steps)
      out.push([5 * Math.cos(t), 5 * Math.cos(PHI) * Math.sin(t)])
    }
    return out
  }

  function ellipseTruth(a: number, b: number, a0: number, a1: number, steps = 128): Pt[] {
    const out: Pt[] = []
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (a1 - a0) * (i / steps)
      out.push([a * Math.cos(t), b * Math.sin(t)])
    }
    return out
  }

  function pairs(flat: readonly number[]): Pt[] {
    const out: Pt[] = []
    for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
    return out
  }

  // Largest distance from the dense truth to the lowered curve, the measure
  // the lowering itself uses to choose a kind.
  function deviation(out: { kind: string; params: number[] }, truth: Pt[]): number {
    if (out.kind === 'spline') {
      const p = out.params
      return maxDeviationToCubic(truth, [
        [p[0], p[1]], [p[2], p[3]], [p[4], p[5]], [p[6], p[7]],
      ])
    }
    return maxDeviationToFitSpline(truth, pairs(out.params))
  }

  function tolerance(truth: Pt[]): number {
    return PROJECTED_CURVE_FIT_TOL * curveScale(truth)
  }

  function expectFollows(out: { kind: string; params: number[] }, truth: Pt[]): void {
    expect(deviation(out, truth)).toBeLessThanOrEqual(tolerance(truth))
  }

  it('keeps a tilted quarter arc as one cubic', () => {
    // Before: one cubic misses this arc by 3.76e-3 absolute, 5.7e-4 of the
    // curve's size, under the 1.5e-3 rung. The common projected quarter arc
    // therefore keeps its kind and its eight params.
    const out = projectTo2d(arcEdge(0, Math.PI / 2), XY)!
    const truth = arcTruth(0, Math.PI / 2)
    expect(out.kind).toBe('spline')
    expect(out.params).toHaveLength(8)
    expectFollows(out, truth)
    // Endpoints stay exact: t=0 -> (5, 0), t=pi/2 -> (5 cos(pi/2), 5 cos(phi)).
    expect(out.params[0]).toBe(5)
    expect(out.params[1]).toBe(0)
    expect(out.params[6]).toBe(5 * Math.cos(Math.PI / 2))
    expect(out.params[7]).toBe(5 * Math.cos(PHI))
    // The legacy 33-point seed, built through the production 3D frame and
    // projection (not an analytic reimplementation): no stored quarter arc
    // changes its shape when a document re-solves after this feature lands.
    const ax = [1, 0, 0]
    const yAxis = cross(TILT_AXIS, ax)
    const seed: Pt[] = []
    for (let i = 0; i <= 32; i++) {
      const t = (Math.PI / 2) * (i / 32)
      const c = Math.cos(t)
      const s = Math.sin(t)
      seed.push(worldToSketch2d([
        5 * (c * ax[0] + s * yAxis[0]),
        5 * (c * ax[1] + s * yAxis[1]),
        5 * (c * ax[2] + s * yAxis[2]),
      ], XY) as Pt)
    }
    expect(out.params).toEqual(fitCubicBezier(seed))
  })

  it('lowers a tilted half arc to a fit_spline', () => {
    // Before: 2.25e-2 absolute, 2.1e-3 of the size, over the rung.
    const out = projectTo2d(arcEdge(0, Math.PI), XY)!
    const truth = arcTruth(0, Math.PI)
    expect(out.kind).toBe('fit_spline')
    expect(out.params.length).toBeGreaterThan(8)
    expectFollows(out, truth)
  })

  it('lowers a tilted 270 degree arc to a fit_spline with exact endpoints', () => {
    // Before: 2.10e-1 absolute, 1.6e-2 of the size: a quarter of a radius.
    const a0 = 0
    const a1 = (3 * Math.PI) / 2
    const out = projectTo2d(arcEdge(a0, a1), XY)!
    const truth = arcTruth(a0, a1)
    expect(out.kind).toBe('fit_spline')
    expectFollows(out, truth)
    // The joints of a closed profile depend on these: the first and last fit
    // points are the projected source ends, not a fitted approximation.
    expect(out.params[0]).toBe(5)
    expect(out.params[1]).toBe(0)
    expect(out.params[out.params.length - 2]).toBe(5 * Math.cos((3 * Math.PI) / 2))
    expect(out.params[out.params.length - 1]).toBe(-5 * Math.cos(PHI))
  })

  it('lowers a partial ellipse over pi to a fit_spline', () => {
    // Before: 1.85e-2 absolute, 2.2e-3 of the size.
    const g = resolve3dGeometry({
      type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI,
    })!
    const out = projectTo2d(g, XY)!
    const truth = ellipseTruth(4, 2, 0, Math.PI)
    expect(out.kind).toBe('fit_spline')
    expectFollows(out, truth)
    expect(out.params[0]).toBe(4)
    expect(out.params[1]).toBe(0)
    expect(out.params[out.params.length - 2]).toBe(4 * Math.cos(Math.PI))
    expect(out.params[out.params.length - 1]).toBe(2 * Math.sin(Math.PI))
  })

  it('lowers a sampled three-inflection B-spline to a fit_spline', () => {
    // Before: 9.55e-1 absolute, 1.5e-1 of the size. A body spline edge hands
    // over one sampled polyline; it can hold several inflections a single cubic
    // cannot follow.
    const control: Pt[] = [[0, 0], [1, 2], [2, -2], [3, 2], [4, -2], [5, 0]]
    const source = interpolateFitSpline(control)
    const end = source.knots[source.knots.length - 1]
    const samples: Pt[] = []
    for (let i = 0; i <= 32; i++) samples.push(source.eval((end * i) / 32))
    const out = projectTo2d(
      { kindH: 'spline', data: { points: samples.map(p => [p[0], p[1], 0]) } }, XY)!
    expect(out.kind).toBe('fit_spline')
    expectFollows(out, samples)
    expect(out.params[0]).toBe(0)
    expect(out.params[1]).toBe(0)
    expect(out.params[out.params.length - 2]).toBe(5)
    expect(out.params[out.params.length - 1]).toBe(0)
  })

  it('closes a literally closed sampled loop', () => {
    // A closed B-spline edge (the Resin_Mold breakout loop) repeats its first
    // sample bit for bit. One cubic cannot close a loop, and the duplicate
    // sample as an endpoint-only seed is a single zero chord the interpolating
    // spline refuses, so the open chain is fitted and the first point repeated
    // at the end.
    const samples: Pt[] = []
    for (let i = 0; i <= 32; i++) {
      const t = (2 * Math.PI * i) / 32
      samples.push([3 * Math.cos(t), 3 * Math.sin(t)])
    }
    samples[samples.length - 1] = [samples[0][0], samples[0][1]]
    const out = projectTo2d(
      { kindH: 'spline', data: { points: samples.map(p => [p[0], p[1], 0]) } }, XY)!
    expect(out.kind).toBe('fit_spline')
    expect(out.warning).toBeUndefined()
    const p = out.params
    expect(p.length).toBeGreaterThan(4)
    expect(p[p.length - 2]).toBe(p[0])
    expect(p[p.length - 1]).toBe(p[1])
    expectFollows(out, samples)
  })

  it('lowers the same source to identical params twice', () => {
    // The pin plan re-solves from the stored document, so a projection must not
    // depend on any state between calls.
    const source = { kindH: 'spline' as const, data: { points: [[0, 0, 0], [1, 2, 0], [2, -2, 0], [3, 0, 0]] } }
    const first = projectTo2d(source, XY)!
    const second = projectTo2d(source, XY)!
    expect(second).toEqual(first)
    const arcFirst = projectTo2d(arcEdge(0, (3 * Math.PI) / 2), XY)!
    const arcSecond = projectTo2d(arcEdge(0, (3 * Math.PI) / 2), XY)!
    expect(arcSecond).toEqual(arcFirst)
  })
})

describe('spline projection', () => {
  it('recovers the endpoints of a sampled cubic on the XY plane', () => {
    // Sample a known cubic Bezier P1..P4 in 3D (z=0), project, fit.
    const C = [[0, 0], [1, 3], [4, 3], [5, 0]]
    const bez = (t: number, i: number) => {
      const mt = 1 - t
      return mt * mt * mt * C[0][i] + 3 * mt * mt * t * C[1][i] + 3 * mt * t * t * C[2][i] + t * t * t * C[3][i]
    }
    const pts3d: number[][] = []
    for (let k = 0; k <= 32; k++) {
      const t = k / 32
      pts3d.push([bez(t, 0), bez(t, 1), 0])
    }
    const g: Resolved3dGeometry = { kindH: 'spline', data: { points: pts3d } }
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('spline')
    const p = out.params
    expect(p[0]).toBeCloseTo(0)  // P1
    expect(p[1]).toBeCloseTo(0)
    expect(p[6]).toBeCloseTo(5)  // P4
    expect(p[7]).toBeCloseTo(0)
    // Interior controls recovered within tolerance.
    expect(p[2]).toBeCloseTo(1, 1)
    expect(p[3]).toBeCloseTo(3, 1)
    expect(p[4]).toBeCloseTo(4, 1)
    expect(p[5]).toBeCloseTo(3, 1)
  })
})
