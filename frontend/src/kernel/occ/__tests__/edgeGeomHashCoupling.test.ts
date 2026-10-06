// Regression guard for the edgeToGeom <-> edgeGeometryHash coupling.
//
// Invariant: every edge KIND edgeToGeom can emit must be hashed by
// edgeGeometryHash as a function of its geometry, so two geometrically distinct
// edges never collide. Both sides now carry a first-class ellipse arm
// (primitives.ts edgeToGeom, geomHash.ts edgeGeometryHash); the original bug was
// an ellipse arm on the edgeToGeom side only, which collapsed every elliptical
// edge to the constant "ellipse|0|0|0" and made ancestry queries and selection
// ids collide. These tests keep the two sides coupled. We drive the real
// edgeToGeom with a minimal fake OCC adaptor (no opencascade.js needed): it
// reports an ELLIPSE curve type and exposes a full ellipse accessor.
import { describe, it, expect } from 'vitest'
import { edgeToGeom } from '@/kernel/occ/primitives'
import { edgeGeometryHash } from '@/kernel/geomHash'
import type { OccModule, OccShape } from '@/kernel/occ/occTypes'
import type { DisposeScope } from '@/kernel/occ/disposeScope'

// By-value gp_* proxies: edgeToGeom reads then deletes each one it gets back.
const xyz = (x: number, y: number, z: number) => ({ X: () => x, Y: () => y, Z: () => z, delete: () => {} })

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
    // Sampled only if some future kind falls through to the spline path;
    // geometry-dependent so distinct ellipses stay distinct either way.
    Value: (u: number) => xyz(center[0] + a * Math.cos(u), center[1] + b * Math.sin(u), center[2]),
    Circle: () => { throw new Error('not a circle') },
    // The ellipse accessor edgeToGeom now uses; kept so the coupled path fails
    // on the hash-collision assertion, not on a missing accessor. The frame
    // accessors return by-value proxies too, hence their delete().
    Ellipse: () => ({
      Location: () => xyz(center[0], center[1], center[2]),
      MajorRadius: () => a,
      MinorRadius: () => b,
      Axis: () => ({ Direction: () => xyz(0, 0, 1), delete: () => {} }),
      XAxis: () => ({ Direction: () => xyz(1, 0, 0), delete: () => {} }),
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
