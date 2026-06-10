// Pure projection lowering: resolve a source payload to 3D, project to 2D
// entity params on a sketch plane. Covers all edge kinds the OCC reader emits
// plus the orientation-aware circle -> ellipse promotion (full-brep-projection).
import { describe, it, expect } from 'vitest'
import {
  resolve3dGeometry,
  projectTo2d,
  circleToEllipseParams,
  type PlaneFrame,
  type Resolved3dGeometry,
} from './projectionLowering'

// XY sketch plane: normal = +Z.
const XY: PlaneFrame = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }

describe('resolve3dGeometry', () => {
  it('reads a vertex payload as a point', () => {
    const g = resolve3dGeometry({ type: 'vertex', x: 1, y: 2, z: 3 }, '?v')
    expect(g).toEqual({ kindH: 'point', data: { point: [1, 2, 3] } })
  })

  it('reads a line edge', () => {
    const g = resolve3dGeometry({ type: 'edge', kind: 'line', start: [0, 0, 0], end: [4, 0, 0] }, '?e')
    expect(g).toEqual({ kindH: 'line', data: { start: [0, 0, 0], end: [4, 0, 0] } })
  })

  it('carries circle axis/x_axis through for orientation detection', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0] },
      '?e',
    )
    expect(g?.kindH).toBe('circle')
    expect(g?.data.axis).toEqual([0, 0, 1])
  })

  it('reads an ellipse edge', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'ellipse', center: [1, 2, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] },
      '?e',
    )
    expect(g?.kindH).toBe('ellipse')
    expect(g?.data).toMatchObject({ center: [1, 2, 0], a: 4, b: 2 })
  })

  it('reads a sampled spline edge', () => {
    const pts = [[0, 0, 0], [1, 1, 0], [2, 0, 0]]
    const g = resolve3dGeometry({ type: 'edge', kind: 'spline', points: pts }, '?e')
    expect(g).toEqual({ kindH: 'spline', data: { points: pts } })
  })

  it('rejects an ellipse edge missing semi-axes', () => {
    expect(resolve3dGeometry({ type: 'edge', kind: 'ellipse', center: [0, 0, 0] }, '?e')).toBeNull()
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

describe('orientation-aware circle projection', () => {
  it('a circle parallel to the sketch plane stays a circle', () => {
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [1, 2, 7], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0] },
      '?e',
    )!
    const out = projectTo2d(g, XY)
    expect(out?.kind).toBe('circle')
    expect(out?.params).toEqual([1, 2, 5])
  })

  it('a circle tilted 60 deg about X projects to an ellipse (a=R, b=R cos60)', () => {
    const phi = Math.PI / 3  // 60 degrees
    // Circle plane normal tilted off +Z by phi about the X axis.
    const axis = [0, -Math.sin(phi), Math.cos(phi)]
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5, axis, x_axis: [1, 0, 0] },
      '?e',
    )!
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
      { type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis: [1, 0, 0] },
      '?e',
    )!
    const out = projectTo2d(g, XY)
    expect(out?.kind).toBe('ellipse')
    const [cx, cy, a, b, theta] = out!.params
    expect(cx).toBeCloseTo(0)
    expect(cy).toBeCloseTo(0)
    expect(a).toBeCloseTo(4)
    expect(b).toBeCloseTo(2)
    expect(theta).toBeCloseTo(0)
  })

  it('a partial elliptical arc projects as a spline (no 2D ellipse-arc entity)', () => {
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
        axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      },
      '?e',
    )!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('spline')
    const p = out.params
    // Endpoints pinned: t=0 -> [4,0], t=pi/2 -> [0,2].
    expect(p[0]).toBeCloseTo(4)
    expect(p[1]).toBeCloseTo(0)
    expect(p[6]).toBeCloseTo(0)
    expect(p[7]).toBeCloseTo(2)
  })

  it('a rotated in-plane ellipse reports its rotation', () => {
    // Major axis along the 2D 45 deg direction.
    const x_axis = [Math.SQRT1_2, Math.SQRT1_2, 0]
    const g = resolve3dGeometry(
      { type: 'edge', kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2, axis: [0, 0, 1], x_axis },
      '?e',
    )!
    const out = projectTo2d(g, XY)!
    const [, , a, b, theta] = out.params
    expect(a).toBeCloseTo(4)
    expect(b).toBeCloseTo(2)
    expect(Math.abs(theta)).toBeCloseTo(45)
  })
})

describe('arc projection (3D body arc)', () => {
  it('projects a quarter arc on the XY plane to 2D angles', () => {
    const g = resolve3dGeometry(
      {
        type: 'edge', kind: 'arc', center: [0, 0, 0], radius: 5,
        axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
      },
      '?e',
    )!
    const out = projectTo2d(g, XY)!
    expect(out.kind).toBe('arc')
    const [cx, cy, r, sa, ea] = out.params
    expect(cx).toBeCloseTo(0)
    expect(cy).toBeCloseTo(0)
    expect(r).toBeCloseTo(5)
    expect(sa).toBeCloseTo(0)
    expect(ea).toBeCloseTo(Math.PI / 2)
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
