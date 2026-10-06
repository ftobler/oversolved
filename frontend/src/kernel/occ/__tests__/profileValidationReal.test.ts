// @vitest-environment node
//
// Real-OCC gates for the profile build: the three refusals that used to be
// silent, and the dump that now rides on the throw. Skips when opencascade.js
// is not installed (npm run occ:install).
//
// The point of every case here is a NEGATIVE: a wire or face the kernel will
// not build must fail loudly. Before these guards, a not-done face builder
// handed back a NULL shape without throwing, and an open chain of edges passed
// the edge-count check and became a solid.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import {
  makeArcEdge,
  makeFaceFromWire,
  makeLineEdge,
  makeWire,
  wireEndpointGaps,
  wireVertexCount,
  type Vec3,
} from '../primitives'
import { sketchLoopsToFace } from '../prismLineage'
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
    } finally {
      scope.dispose()
    }
  })

  it('leaves an arc/arc joint above OCC confusion for the guards to reject', () => {
    // The widest part of requireClosed's blast radius. snapLoopJoints refuses to
    // move an anchored/anchored joint (neither endpoint can leave its curve), so
    // such a profile depends entirely on healWireFromEdges -- and this pins that
    // the heal does NOT save it today. Two semicircles whose radii differ by
    // 5e-7 meet 5e-7 apart at both joints. Characterization only: closing this
    // gap is F3, which is out of scope.
    const scope = new DisposeScope()
    try {
      const loop: LoopEdge[] = [arcLoopEdge(5, 0, 180), arcLoopEdge(5 + 5e-7, 180, 360)]
      let message = ''
      expect(() => {
        try {
          sketchLoopsToFace(occ, scope, [loop], XY_PLANE)
        } catch (e) {
          message = e instanceof Error ? e.message : String(e)
          throw e
        }
      }).toThrow()
      // The kernel dropped an edge rather than healing the joint.
      expect(message).toContain('of 2 edges connected')
      // And the dump names WHY nothing upstream could have repaired it.
      expect(message).toContain('both sides are anchored to a curve')
      expect(message).toContain('unsnappable')
    } finally {
      scope.dispose()
    }
  })

  it('reports the gaps OCC realized alongside the ones the sketch asked for', () => {
    // An arc endpoint is forced onto its ideal circle, so the uv coordinates the
    // sketch stored and the points the kernel built are different numbers. The
    // failure has to carry both or it cannot identify that class of joint.
    const scope = new DisposeScope()
    try {
      const loop: LoopEdge[] = [arcLoopEdge(5, 0, 180), arcLoopEdge(5 + 5e-7, 180, 360)]
      let message = ''
      try {
        sketchLoopsToFace(occ, scope, [loop], XY_PLANE)
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).toContain('gaps OCC realized at each joint')
      expect(message).toMatch(/gaps OCC realized at each joint: 5\.000e-7, 5\.000e-7/)
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
