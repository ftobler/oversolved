// Pure tests for the arc-joint decision: the circle through an arc's two
// stored endpoints, on its authored radius. No OCC, no WASM.

import { describe, it, expect } from 'vitest'
import { arcJointCircle, ellipseJointAngles } from '../prismProfile'
import type { LoopEdge } from '../../profileLoops'

function point(center: number[], radius: number, angleDeg: number): number[] {
  const a = (angleDeg * Math.PI) / 180
  return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]
}

function arc(overrides: Partial<LoopEdge>): LoopEdge {
  return {
    kind: 'arc',
    center: [0, 0],
    radius: 5,
    angle_start_deg: 0,
    angle_end_deg: 90,
    ccw: true,
    start: [5, 0],
    end: [0, 5],
    ...overrides,
  }
}

describe('arcJointCircle', () => {
  it('builds both kinked arcs through their own stored joint, not their stored angles', () => {
    // Arc A ends at (0,4) exactly. Arc B is on a different radius and centre
    // (so the joint is kinked, not tangent), and its authored start angle
    // points 5e-7 away from the shared stored joint. Re-angling each arc on its
    // own circle would leave that residual; the joint circle must not.
    const joint = [0, 4]
    const a = arc({
      id: 'a1',
      center: [0, 0],
      radius: 4,
      angle_start_deg: 0,
      angle_end_deg: 90,
      start: [4, 0],
      end: joint,
    })
    const angularOffset = (5e-7 / 5) * (180 / Math.PI)
    const b = arc({
      id: 'b1',
      center: [5, 4],
      radius: 5,
      angle_start_deg: 180 + angularOffset,
      angle_end_deg: 270,
      start: joint,
      end: [5, -1],
    })

    const ja = arcJointCircle(a)
    const jb = arcJointCircle(b)
    expect(ja.ok).toBe(true)
    expect(jb.ok).toBe(true)
    if (!ja.ok || !jb.ok) return

    // Both sides realize the shared joint as the same 2D point.
    const aEnd = point(ja.center, ja.radius, ja.angleEndDeg)
    const bStart = point(jb.center, jb.radius, jb.angleStartDeg)
    expect(aEnd[0]).toBeCloseTo(joint[0], 12)
    expect(aEnd[1]).toBeCloseTo(joint[1], 12)
    expect(bStart[0]).toBeCloseTo(joint[0], 12)
    expect(bStart[1]).toBeCloseTo(joint[1], 12)
    expect(Math.hypot(aEnd[0] - bStart[0], aEnd[1] - bStart[1])).toBeLessThan(1e-12)

    // And each arc still reproduces its own stored non-joint endpoint.
    const aStart = point(ja.center, ja.radius, ja.angleStartDeg)
    const bEnd = point(jb.center, jb.radius, jb.angleEndDeg)
    expect(aStart[0]).toBeCloseTo(4, 12)
    expect(aStart[1]).toBeCloseTo(0, 12)
    expect(bEnd[0]).toBeCloseTo(5, 12)
    expect(bEnd[1]).toBeCloseTo(-1, 12)
  })

  it('refuses an endpoint whose derived centre is off the stored centre', () => {
    const bad = arc({
      id: 'bad-centre',
      radius: 5,
      angle_start_deg: 0,
      angle_end_deg: 90,
      start: [8, 0],
      end: [0, 5],
    })
    const r = arcJointCircle(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('center')
    expect(r.edge).toBe('bad-centre')
    expect(r.centerShift).toBeGreaterThan(1e-3)
    expect(r.radialError).toBeCloseTo(3, 9)
    expect(r.message).toContain('bad-centre')
    expect(r.message).toContain('centre shifted')
    expect(r.message).toContain('radial error')
  })

  it('refuses a near-semicircle whose radius cannot span both merged endpoints', () => {
    // The plan's centre-shift guard is deliberately not relaxed for a chord
    // near the diameter: the authored circle would move ~sqrt(2 r dr) away, so
    // the "arc" would be visibly different even though its radial error is 5e-7.
    const bad = arc({
      id: 'near-semicircle',
      radius: 5 + 5e-7,
      angle_start_deg: 180,
      angle_end_deg: 360,
      start: [-5, 0],
      end: [5, 0],
    })
    const r = arcJointCircle(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('center')
    expect(r.centerShift).toBeGreaterThan(1e-3)
    expect(r.radialError).toBeCloseTo(5e-7, 9)
  })

  it('refuses an endpoint on the circle at a grossly different angle instead of taking the complement', () => {
    // Stored angles say a 90 degree CCW arc, stored endpoints say 270 degrees.
    const bad = arc({
      id: 'bad-sweep',
      angle_start_deg: 0,
      angle_end_deg: 90,
      start: [5, 0],
      end: [0, -5],
    })
    const r = arcJointCircle(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('sweep')
    expect(r.edge).toBe('bad-sweep')
    expect(r.angularError).toBeCloseTo(Math.PI, 9)
    expect(r.message).toContain('angular error')
  })

  it('keeps the stored-angle construction for a face-loop arc with no endpoints', () => {
    // extractFaceLoops emits an arc from its pcurve with no 2D endpoints; there
    // is no joint to build through, and refusing it would break every face loop.
    const pc = arc({
      id: 'pcurve',
      angle_start_deg: 30,
      angle_end_deg: 120,
      start: undefined,
      end: undefined,
    })
    const r = arcJointCircle(pc)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fullTurn).toBe(false)
    expect(r.center).toEqual([0, 0])
    expect(r.angleStartDeg).toBe(30)
    expect(r.angleEndDeg).toBe(120)
  })

  it('keeps a stored full turn on its stored span before deriving endpoints', () => {
    const circle = arc({
      id: 'full',
      angle_start_deg: 0,
      angle_end_deg: 360,
      start: [5, 0],
      end: [5, 0],
    })
    const r = arcJointCircle(circle)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fullTurn).toBe(true)
  })
})

describe('ellipseJointAngles', () => {
  it('projects the stored joint into the ellipse frame and reports the residual', () => {
    const e: LoopEdge = {
      kind: 'ellipse_arc',
      center: [0, 0],
      a: 4,
      b: 2,
      theta: 0,
      angle_start_deg: 0,
      angle_end_deg: 90,
      ccw: true,
      start: [4 + 2e-6, 0],
      end: [0, 2],
    }
    const r = ellipseJointAngles(e)
    expect(r.angleStartDeg).toBeCloseTo(0, 9)
    expect(r.angleEndDeg).toBeCloseTo(90, 9)
    expect(r.radialError).toBeCloseTo(2e-6, 12)
    expect(r.angularError).toBeCloseTo(0, 9)
  })

  it('keeps a full-turn elliptical arc on its stored span', () => {
    const e: LoopEdge = {
      kind: 'ellipse_arc',
      center: [0, 0],
      a: 4,
      b: 2,
      theta: 0,
      angle_start_deg: 0,
      angle_end_deg: 360,
      ccw: true,
      start: [4, 0],
      end: [4, 0],
    }
    const r = ellipseJointAngles(e)
    expect(r.angleStartDeg).toBe(0)
    expect(r.angleEndDeg).toBe(360)
    expect(r.radialError).toBe(0)
  })
})
