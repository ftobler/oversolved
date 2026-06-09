// Regression guard for the edgeToGeom <-> edgeGeometryHash coupling.
//
// Bug (ellipse-entity, caught in review): adding a GeomAbs_Ellipse arm to
// edgeToGeom made elliptical B-rep edges return `kind: 'ellipse'`, but
// edgeGeometryHash had no ellipse branch -- it collapsed every such edge to the
// constant "ellipse|0|0|0". All elliptical edges then shared one geom hash, so
// their ancestry queries and selection-buffer ids collided (non-unique ids,
// drifted queries on pre-existing documents).
//
// Invariant this guards: every edge KIND that edgeToGeom can emit must be hashed
// by edgeGeometryHash as a function of its geometry, so two geometrically
// distinct edges never collide. We drive the real edgeToGeom with a minimal
// fake OCC adaptor (no opencascade.js needed). The fake reports an ELLIPSE curve
// type and exposes a full ellipse accessor, so:
//   - current code (no edgeToGeom ellipse arm): the edge falls through to the
//     spline sampler, hashed by its sampled points -> distinct geometries differ.
//   - if a future edgeToGeom ellipse arm is re-added WITHOUT a matching
//     edgeGeometryHash branch: both edges become kind:'ellipse' with no points
//     and collapse to one constant hash -> the distinctness assertion fails.
import { describe, it, expect } from 'vitest'
import { edgeToGeom } from '@/kernel/occ/primitives'
import { edgeGeometryHash } from '@/kernel/geomHash'
import type { OccModule, OccShape } from '@/kernel/occ/occTypes'
import type { DisposeScope } from '@/kernel/occ/disposeScope'

const xyz = (x: number, y: number, z: number) => ({ X: () => x, Y: () => y, Z: () => z })

const LINE = { value: 1 }
const CIRCLE = { value: 2 }
const ELLIPSE = { value: 3 }

const fakeScope = { track: <T,>(x: T): T => x } as unknown as DisposeScope

/** Fake OCC module exposing an ellipse-typed curve adaptor with center/semi-axes. */
function ellipseEdgeOcc(center: [number, number, number], a: number, b: number): OccModule {
  const ad = {
    GetType: () => ELLIPSE,
    FirstParameter: () => 0,
    LastParameter: () => 2 * Math.PI,
    // Sampled by the spline fallback today; geometry-dependent so distinct
    // ellipses sample to distinct polylines.
    Value: (u: number) => xyz(center[0] + a * Math.cos(u), center[1] + b * Math.sin(u), center[2]),
    Circle: () => { throw new Error('not a circle') },
    // Used only if an edgeToGeom ellipse arm is (re-)added; present so that path
    // fails on the hash-collision assertion, not on a missing accessor.
    Ellipse: () => ({
      Location: () => xyz(center[0], center[1], center[2]),
      MajorRadius: () => a,
      MinorRadius: () => b,
      Axis: () => ({ Direction: () => xyz(0, 0, 1) }),
      XAxis: () => ({ Direction: () => xyz(1, 0, 0) }),
      dispose: () => {},
    }),
    dispose: () => {},
  }
  return {
    BRepAdaptor_Curve_2: function () { return ad },
    GeomAbs_CurveType: { GeomAbs_Line: LINE, GeomAbs_Circle: CIRCLE, GeomAbs_Ellipse: ELLIPSE },
  } as unknown as OccModule
}

const hashOf = (oc: OccModule) =>
  edgeGeometryHash(edgeToGeom(oc, fakeScope, {} as OccShape).ed as unknown as Record<string, unknown>)

describe('edgeToGeom / edgeGeometryHash coupling', () => {
  it('geometrically distinct elliptical edges hash to distinct values', () => {
    const h1 = hashOf(ellipseEdgeOcc([0, 0, 0], 4, 2))
    const h2 = hashOf(ellipseEdgeOcc([5, 5, 0], 3, 1))
    expect(h1).not.toBe(h2)
  })

  it('the same ellipse hashes stably (sanity: hashing is geometry-determined)', () => {
    expect(hashOf(ellipseEdgeOcc([1, 2, 3], 4, 2))).toBe(hashOf(ellipseEdgeOcc([1, 2, 3], 4, 2)))
  })
})
