// @vitest-environment node
//
// Real-OCC gates for the profile build: the refusals that used to be silent,
// the dump that now rides on the throw, and the joint weld that builds a merged
// arc loop into the wire the analyser described. Skips when opencascade.js is
// not installed (npm run occ:install).
//
// A refusal must fail loudly: before these guards, a not-done face builder
// handed back a NULL shape without throwing, and an open chain of edges passed
// the edge-count check and became a solid. The joint cases are the other side:
// a loop the analyser called closed must reach OCC closed.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import {
  makeArcEdge,
  makeFaceFromWire,
  makeLineEdge,
  makePrism,
  makeWire,
  wireEndpointGaps,
  wireVertexCount,
  type Vec3,
} from '../primitives'
import { sketchLoopsToFace, sweepProfileWithLineage } from '../prismLineage'
import { buildArcEdge } from '../prismProfile'
import { volumeOf } from '../booleans'
import { describeProfile } from '../../profileDiagnostics'
import type { OccModule } from '../occTypes'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'

const oc = await loadOcc()

const XY_PLANE: PlaneLike = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, 1, 0],
  normal: [0, 0, 1],
}

/** One CCW arc of a circle centred at the origin, as the DCEL would emit it. */
function arcLoopEdge(r: number, a0: number, a1: number): LoopEdge {
  const t0 = (a0 * Math.PI) / 180
  const t1 = (a1 * Math.PI) / 180
  return {
    kind: 'arc',
    center: [0, 0],
    radius: r,
    angle_start_deg: a0,
    angle_end_deg: a1,
    ccw: true,
    start: [r * Math.cos(t0), r * Math.sin(t0)],
    end: [r * Math.cos(t1), r * Math.sin(t1)],
  }
}

/** A square profile whose closing joint is opened by `gap` in +y. */
function gappedSquare(gap: number): LoopEdge[] {
  return [
    { kind: 'line', start: [0, 0], end: [10, 0] },
    { kind: 'line', start: [10, 0], end: [10, 10] },
    { kind: 'line', start: [10, 10], end: [0, 10] },
    { kind: 'line', start: [0, 10], end: [0, gap] },
  ]
}

function arcPoint(center: number[], radius: number, deg: number): number[] {
  const a = (deg * Math.PI) / 180
  return [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)]
}

/**
 * The cutter's s1 loop with every joint already on the merged position the
 * area builder hands the wire: the anchored arc side wins. Its stored angles
 * are the authored ones, so the old angle-only builder put the arc/arc joints
 * 1.7e-7 and 5.2e-7 apart.
 */
function cutterLoop(): LoopEdge[] {
  const a1: LoopEdge = {
    id: 'a1', kind: 'arc', center: [0, 0], radius: 4, ccw: true,
    angle_start_deg: 146.93351, angle_end_deg: 134.349402,
  }
  a1.start = arcPoint([0, 0], 4, 146.93351)
  a1.end = arcPoint([0, 0], 4, 134.349402)
  const line: LoopEdge = { id: 'ln', kind: 'line', start: [-2.796128, 2.860361], end: [-3.40496, 3.661455] }
  const a2: LoopEdge = {
    id: 'a2', kind: 'arc', center: [0, 0], radius: 5, ccw: true,
    angle_start_deg: 132.921203, angle_end_deg: 135,
  }
  a2.start = arcPoint([0, 0], 5, 132.921203)
  a2.end = arcPoint([0, 0], 5, 135)
  const a3: LoopEdge = {
    id: 'a3', kind: 'arc', center: [-1.06066, 3.181981], radius: 2.5, ccw: true,
    angle_start_deg: 171.869898, angle_end_deg: 203.566497,
  }
  a3.start = arcPoint([-1.06066, 3.181981], 2.5, 171.869898)
  a3.end = arcPoint([-1.06066, 3.181981], 2.5, 203.566497)
  // Merged joint positions: the anchored side wins, and both sides carry it.
  line.start = [...(a1.end as number[])]
  line.end = [...(a2.start as number[])]
  a3.start = [...(a2.end as number[])]
  a3.end = [...(a1.start as number[])]
  return [a1, line, a2, a3]
}

/** The exact boundary-integral area of a loop of lines and circular arcs. */
function analyticLoopArea(loop: LoopEdge[]): number {
  let acc = 0
  for (const e of loop) {
    const start = e['start'] as number[]
    const end = e['end'] as number[]
    if (e['kind'] === 'line') {
      acc += start[0] * end[1] - start[1] * end[0]
      continue
    }
    const center = e['center'] as number[]
    const radius = e['radius'] as number
    const a0 = ((e['angle_start_deg'] as number) * Math.PI) / 180
    const a1 = ((e['angle_end_deg'] as number) * Math.PI) / 180
    const twoPi = 2 * Math.PI
    const ccw = (e['ccw'] as boolean) ?? true
    const sweep = ccw
      ? ((a1 - a0) % twoPi + twoPi) % twoPi
      : -(((a0 - a1) % twoPi + twoPi) % twoPi)
    const aEnd = a0 + sweep
    acc += radius * radius * sweep
      + radius * (center[0] * (Math.sin(aEnd) - Math.sin(a0)) - center[1] * (Math.cos(aEnd) - Math.cos(a0)))
  }
  return acc / 2
}

describe.skipIf(!oc)('profile validation (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  it('counts a closed wire as edges == distinct vertices and an open one as one more', () => {
    const scope = new DisposeScope()
    try {
      const p: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]
      // makeWire returns the wire UNTRACKED (the caller owns it), so each one
      // has to be handed to the scope or the test leaks it.
      const closed = scope.track(makeWire(occ, scope, p.map((q, i) => makeLineEdge(occ, scope, q, p[(i + 1) % 4]))))
      expect(wireVertexCount(occ, scope, closed)).toBe(4)
      const open = scope.track(makeWire(occ, scope, [
        makeLineEdge(occ, scope, p[0], p[1]),
        makeLineEdge(occ, scope, p[1], p[2]),
        makeLineEdge(occ, scope, p[2], p[3]),
      ]))
      expect(wireVertexCount(occ, scope, open)).toBe(4)
      // A full circle edge is one edge closing on one seam vertex.
      const circle = makeArcEdge(occ, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 5, 0, 2 * Math.PI)
      expect(wireVertexCount(occ, scope, scope.track(makeWire(occ, scope, [circle])))).toBe(1)
    } finally {
      scope.dispose()
    }
  })

  it('reads the gaps OCC actually realized, not the ones we asked for', () => {
    const scope = new DisposeScope()
    try {
      const edges = [
        makeLineEdge(occ, scope, [0, 0, 0], [10, 0, 0]),
        makeLineEdge(occ, scope, [10, 0, 0], [10, 10, 0]),
        makeLineEdge(occ, scope, [10, 10, 0], [0, 10, 0]),
        makeLineEdge(occ, scope, [0, 10, 0], [0, 5e-3, 0]),
      ]
      const gaps = wireEndpointGaps(occ, scope, edges)
      expect(gaps).toHaveLength(4)
      expect(gaps.slice(0, 3).every((g) => g < 1e-12)).toBe(true)
      // The last entry is the closure: last edge's end back to the first start.
      expect(gaps[3]).toBeCloseTo(5e-3, 12)
    } finally {
      scope.dispose()
    }
  })

  it('makeFaceFromWire refuses a not-done builder instead of returning a face', () => {
    const scope = new DisposeScope()
    try {
      // Non-coplanar: one corner lifted out of z=0. onlyPlane leaves the builder
      // not-done, and Face() then hands back a NULL shape WITHOUT throwing.
      const p: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 5], [0, 10, 0]]
      const wire = scope.track(makeWire(occ, scope, p.map((q, i) => makeLineEdge(occ, scope, q, p[(i + 1) % 4]))))
      let message = ''
      expect(() => {
        try {
          makeFaceFromWire(occ, scope, wire)
        } catch (e) {
          message = e instanceof Error ? e.message : String(e)
          throw e
        }
      }).toThrow()
      expect(message).toContain('does not bound a planar face')
      // Never a bare emscripten pointer.
      expect(message).not.toMatch(/^\d+$/)
    } finally {
      scope.dispose()
    }
  })

  it('makeWire refuses an open chain even when every edge connected', () => {
    const scope = new DisposeScope()
    try {
      const p: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]
      const edges = [
        makeLineEdge(occ, scope, p[0], p[1]),
        makeLineEdge(occ, scope, p[1], p[2]),
        makeLineEdge(occ, scope, p[2], p[3]),
      ]
      // The edge-count guard is satisfied: all three edges are in the wire.
      expect(wireVertexCount(occ, scope, scope.track(makeWire(occ, scope, edges)))).toBe(edges.length + 1)
      expect(() => makeWire(occ, scope, edges, { requireClosed: true }))
        .toThrow(/wire is open \(3 edges but 4 distinct vertices\)/)
    } finally {
      scope.dispose()
    }
  })

  it('makeWire refuses a self-touching closed wire as pinched', () => {
    // A bowtie: two triangles sharing one vertex. Every joint connects, so the
    // edge-count guard is satisfied, but the wire has fewer distinct vertices
    // than edges -- it touches itself and bounds no single region. The refusal
    // must name the pinch, not the open-chain message.
    const scope = new DisposeScope()
    try {
      const v1: Vec3 = [0, 0, 0]
      const v2: Vec3 = [1, 0, 0]
      const v3: Vec3 = [0, 1, 0]
      const v4: Vec3 = [-1, 0, 0]
      const v5: Vec3 = [0, -1, 0]
      const edges = [
        makeLineEdge(occ, scope, v1, v2),
        makeLineEdge(occ, scope, v2, v3),
        makeLineEdge(occ, scope, v3, v1),
        makeLineEdge(occ, scope, v1, v4),
        makeLineEdge(occ, scope, v4, v5),
        makeLineEdge(occ, scope, v5, v1),
      ]
      expect(wireVertexCount(occ, scope, scope.track(makeWire(occ, scope, edges)))).toBe(edges.length - 1)
      expect(() => makeWire(occ, scope, edges, { requireClosed: true }))
        .toThrow(/wire is pinched \(6 edges sharing only 5 distinct vertices\)/)
    } finally {
      scope.dispose()
    }
  })

  it('never silently builds an invalid face from a joint inside the sketch epsilon', () => {
    // The required tolerance boundary case: 5e-7 sits above OCC's confusion
    // (1e-7) and below TOL_LOOP_CLOSURE (1e-6). Exactly one of two outcomes is
    // acceptable -- a valid face (the joint snap closed it) or a throw naming
    // the gap. A face that builds and fails BRepCheck is the third outcome, and
    // it is what this asserts cannot happen.
    const scope = new DisposeScope()
    try {
      let face = null
      let message = ''
      try {
        face = sketchLoopsToFace(occ, scope, [gappedSquare(5e-7)], XY_PLANE)
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      if (face !== null) {
        expect(scope.track(new occ.BRepCheck_Analyzer(face, true)).IsValid_2()).toBe(true)
      } else {
        expect(message).toMatch(/gap|open|closureGap/)
      }
    } finally {
      scope.dispose()
    }
  })

  it('attaches the profile dump when the wire build throws', () => {
    // 5e-3 is beyond JOINT_SNAP_TOL, so nothing upstream repairs it.
    const scope = new DisposeScope()
    try {
      let message = ''
      expect(() => {
        try {
          sketchLoopsToFace(occ, scope, [gappedSquare(5e-3)], XY_PLANE)
        } catch (e) {
          message = e instanceof Error ? e.message : String(e)
          throw e
        }
      }).toThrow()
      expect(message).toContain('closureGap')
      expect(message).toContain('5.000e-3')
      expect(message).toContain('joint 3 line->line')
      expect(message).toContain('reasons:')
      // The connectivity guard still names how many edges made it.
      expect(message).toContain('4 edges but 5 distinct vertices')
    } finally {
      scope.dispose()
    }
  })

  it('builds an arc/arc joint once the upstream merge gives both sides one endpoint', () => {
    // Both sides anchored and 5e-7 apart on their authored circles, so
    // snapLoopJoints cannot move either. The area builder merges them to one
    // vertex; the arc builder must build through that shared point, not through
    // each arc's stored angles. A shallow pair keeps the derived centre shift
    // well inside JOINT_SNAP_TOL (a semicircle's near-diameter chord does not).
    const scope = new DisposeScope()
    try {
      const a = arcLoopEdge(5, 0, 90)
      const b = arcLoopEdge(5 + 5e-7, 90, 0)
      b.ccw = false
      b.start = [0, 5]
      b.end = [5, 0]
      const loop: LoopEdge[] = [a, b]
      const face = scope.track(sketchLoopsToFace(occ, scope, [loop], XY_PLANE))
      expect(scope.track(new occ.BRepCheck_Analyzer(face, true)).IsValid_2()).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('reports the gaps OCC realized alongside the ones the sketch asked for', () => {
    // A genuinely open loop: 5e-3 is beyond JOINT_SNAP_TOL, so nothing upstream
    // repairs it. The failure has to carry both the uv-space joint gap and the
    // points the kernel actually built.
    const scope = new DisposeScope()
    try {
      let message = ''
      try {
        sketchLoopsToFace(occ, scope, [gappedSquare(5e-3)], XY_PLANE)
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).toContain('gaps OCC realized at each joint')
      expect(message).toMatch(/gaps OCC realized at each joint: 0, 0, 0, 5\.000e-3/)
    } finally {
      scope.dispose()
    }
  })

  it('builds the cutter arc/arc loop from its merged joints with zero realized gaps', () => {
    const loop = cutterLoop()
    const report = describeProfile([loop])
    expect(report.verdict).toBe('ok')
    const scope = new DisposeScope()
    try {
      const edges = loop.map((e) => {
        if (e['kind'] === 'arc') return scope.track(buildArcEdge(occ, scope, XY_PLANE, e))
        const s = e['start'] as number[]
        const en = e['end'] as number[]
        return scope.track(makeLineEdge(occ, scope, [s[0], s[1], 0], [en[0], en[1], 0]))
      })
      const gaps = wireEndpointGaps(occ, scope, edges)
      expect(gaps).toHaveLength(4)
      for (const g of gaps) expect(g).toBeLessThan(1e-12)

      const face = scope.track(sketchLoopsToFace(occ, scope, [loop], XY_PLANE))
      expect(scope.track(new occ.BRepCheck_Analyzer(face, true)).IsValid_2()).toBe(true)
      const solid = scope.track(makePrism(occ, scope, face, [0, 0, 1], 1))
      const expected = Math.abs(analyticLoopArea(loop))
      expect(volumeOf(occ, scope, solid)).toBeCloseTo(expected, 5)
    } finally {
      scope.dispose()
    }
  })

  it('sweeps the cutter loop along a straight path', () => {
    const loop = cutterLoop()
    const scope = new DisposeScope()
    try {
      const spine = [scope.track(makeLineEdge(occ, scope, [0, 0, 0], [0, 0, 10]))]
      const swept = sweepProfileWithLineage(occ, scope, [loop], XY_PLANE, spine, 'sk', 'sw')
      expect(volumeOf(occ, scope, swept.solid)).toBeCloseTo(Math.abs(analyticLoopArea(loop)) * 10, 4)
    } finally {
      scope.dispose()
    }
  })

  it('builds two kinked arcs whose authored angle points differ by 5e-7', () => {
    // Same defect without the cutter's exact numbers: two different radii, a
    // non-tangent joint, and the shared merged endpoint on both sides.
    const scope = new DisposeScope()
    try {
      const c2: number[] = [2 - Math.sqrt(17 / 2), 2 - Math.sqrt(17 / 2)]
      const a: LoopEdge = arcLoopEdge(4, 0, 90)
      const startDeg = (Math.atan2(4 - c2[1], 0 - c2[0]) * 180) / Math.PI
      const endDeg = (Math.atan2(0 - c2[1], 4 - c2[0]) * 180) / Math.PI
      const b: LoopEdge = {
        id: 'kinked', kind: 'arc', center: c2, radius: 5, ccw: false,
        angle_start_deg: startDeg + (5e-7 / 5) * (180 / Math.PI),
        angle_end_deg: endDeg + (5e-7 / 5) * (180 / Math.PI),
        start: [0, 4],
        end: [4, 0],
      }
      const loop: LoopEdge[] = [a, b]
      const face = scope.track(sketchLoopsToFace(occ, scope, [loop], XY_PLANE))
      expect(scope.track(new occ.BRepCheck_Analyzer(face, true)).IsValid_2()).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('welds an elliptical-arc joint whose endpoint is inside the merge rung', () => {
    // An ellipse cannot pass through an arbitrary joint, so the stored point is
    // projected and the built edge gets 2e-6 of radial residual. That is over
    // OCC's confusion rung but inside the area builder's merge rung, so the
    // joint must be welded rather than refused.
    const scope = new DisposeScope()
    try {
      const joint = [5 + 2e-6, 0]
      const loop: LoopEdge[] = [
        {
          id: 'ea', kind: 'ellipse_arc', center: [0, 0], a: 5, b: 2, theta: 0,
          angle_start_deg: 0, angle_end_deg: 180, ccw: true,
          start: [...joint], end: [-5, 0],
        },
        { kind: 'line', start: [-5, 0], end: [...joint] },
      ]
      const face = scope.track(sketchLoopsToFace(occ, scope, [loop], XY_PLANE))
      expect(scope.track(new occ.BRepCheck_Analyzer(face, true)).IsValid_2()).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('refuses an elliptical-arc joint past the merge rung instead of projecting it silently', () => {
    const scope = new DisposeScope()
    try {
      const joint = [5 + 2e-4, 0]
      const loop: LoopEdge[] = [
        {
          id: 'far-ea', kind: 'ellipse_arc', center: [0, 0], a: 5, b: 2, theta: 0,
          angle_start_deg: 0, angle_end_deg: 180, ccw: true,
          start: [...joint], end: [-5, 0],
        },
        { kind: 'line', start: [-5, 0], end: [...joint] },
      ]
      let message = ''
      expect(() => {
        try {
          sketchLoopsToFace(occ, scope, [loop], XY_PLANE)
        } catch (e) {
          message = e instanceof Error ? e.message : String(e)
          throw e
        }
      }).toThrow()
      expect(message).toContain('far-ea')
      expect(message).toContain('TOL_TOPOLOGY_MERGE')
    } finally {
      scope.dispose()
    }
  })

  it('describes the loops the kernel saw, not the ones before snapping', () => {
    // snapLoopJoints closes a 5e-7 line/line joint before any edge is built, so
    // the kernel never sees it. Describing the PRE-snap loops made the dev dump
    // fire `suspect` on a profile that built perfectly, on every solve.
    const scope = new DisposeScope()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const face = sketchLoopsToFace(occ, scope, [gappedSquare(5e-7)], XY_PLANE)
      expect(scope.track(new occ.BRepCheck_Analyzer(face, true)).IsValid_2()).toBe(true)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      scope.dispose()
    }
  })

  it('still builds an ordinary square profile', () => {
    const scope = new DisposeScope()
    try {
      const face = sketchLoopsToFace(occ, scope, [gappedSquare(0)], XY_PLANE)
      expect(scope.track(new occ.BRepCheck_Analyzer(face, true)).IsValid_2()).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})
