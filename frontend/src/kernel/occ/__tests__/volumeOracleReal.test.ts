// @vitest-environment node
//
// The analytic-volume oracle: builds primitives and simple features on the real
// kernel, measures them with volumeOf (BRepGProp), and compares against the
// closed-form volumes derived below. Skips when opencascade.js is not
// installed, like every *Real suite.
//
// Every formula is re-derived here from the mathematics, with the derivation
// written at its case; nothing is copied from another project. The rounded-box
// case uses the classical Steiner formula for a parallel body (J. Steiner,
// 1840), applied to the eroded core; the full derivation is at filletVolume.
// The Pappus cases use the second centroid theorem (volume of a solid of
// revolution equals the revolved area times the path of its centroid).
//
// The volume read integrates the exact B-rep (BRepGProp runs Gauss integration
// over the faces), so no tessellation error enters the comparison. The budget
// is proportional to the solid's own size, exactly as a mesh tolerance would
// be: rel * expected covers the integrator's convergence, and an absolute
// floor covers a shape near zero volume. Measured deviations on these cases
// are ~1e-16 relative, six orders inside the 1e-6 budget.
//
// The comparator itself now lives in `occ/measureTolerance.ts` because the
// reference-oracle corpus (`src/oracle/`) applies the same budget to volume,
// area, centroid and bbox; this file keeps the comparator's own unit tests.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../volume'
import { valueWithinTolerance } from '../measureTolerance'
import {
  makeBox,
  makeCylinder,
  makeFaceFromWire,
  makeLineEdge,
  makeWire,
  type Vec3,
} from '../primitives'
import { canonicalEdges } from '../bodyNames'
import { revolveFace } from '../prismLineage'
import { applyFilletWithDiff } from '../edgeModifier'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

// Box: a rectangular prism of side lengths dx, dy, dz is dx layered unit
// squares, so V = dx * dy * dz.
function boxVolume(dx: number, dy: number, dz: number): number {
  return dx * dy * dz
}

// Cylinder: every horizontal slice of a right circular cylinder has area
// pi r^2 (Cavalieri), and h slices stack, so V = pi * r^2 * h.
function cylinderVolume(radius: number, height: number): number {
  return Math.PI * radius * radius * height
}

// Pappus: for a plane region of area A whose centroid is a distance d from the
// axis, a revolution through theta radians sweeps V = theta * d * A (second
// theorem of Pappus; theta = 2pi is the full turn). The annulus case is the
// same number from washers: revolving the strip [r1, r2] x [0, h] about the
// axis gives V = integral pi (r2^2 - r1^2) dh = pi (r2^2 - r1^2) h, and
// (r2 - r1) h * ((r1 + r2) / 2) * 2pi collapses to the same product.
function pappusVolume(thetaRad: number, centroidDistance: number, area: number): number {
  return thetaRad * centroidDistance * area
}

// Rounded box by the Steiner formula. For a convex body K, the parallel body
// K + B_r (every point within distance r) has
//   V(K + B_r) = V(K) + S(K) r + M(K) r^2 + (4/3) pi r^3,
// where S is the surface area and M the integral of mean curvature. For a
// convex polyhedron, M = (1/2) sum over edges of L_e * theta_e with theta_e the
// exterior dihedral angle; a box has theta_e = pi/2 at every edge, so
// M = (pi/4) * sum L_e.
//
// Rounding every edge of the dx x dy x dz box at radius r is K + B_r with K the
// box eroded by r: the inner a x b x c box, a = dx - 2r, etc. (valid while the
// erosion stays a box, r < min(dx, dy, dz) / 2). With S(K) = 2(ab + bc + ca)
// and sum L_e = 4(a + b + c):
//   V = abc + 2(ab + bc + ca) r + pi (a + b + c) r^2 + (4/3) pi r^3.
function filletVolume(dx: number, dy: number, dz: number, radius: number): number {
  const a = dx - 2 * radius
  const b = dy - 2 * radius
  const c = dz - 2 * radius
  return a * b * c
    + 2 * (a * b + b * c + c * a) * radius
    + Math.PI * (a + b + c) * radius * radius
    + (4 / 3) * Math.PI * radius ** 3
}

describe('the volume tolerance comparator', () => {
  it('accepts an exact match', () => {
    expect(valueWithinTolerance(240, 240)).toBe(true)
  })

  it('accepts a shift inside the relative tolerance', () => {
    expect(valueWithinTolerance(240 * (1 + 1e-8), 240)).toBe(true)
  })

  it('rejects a 0.1% shift, far outside the tolerance', () => {
    expect(valueWithinTolerance(240 * 1.001, 240)).toBe(false)
  })

  it('uses the absolute floor for an expected volume near zero', () => {
    expect(valueWithinTolerance(1e-7, 0)).toBe(true)
    expect(valueWithinTolerance(1e-3, 0)).toBe(false)
  })
})

describe.skipIf(!oc)('analytic volumes (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('box: V = dx dy dz', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 20, 10, 6))
      const expected = boxVolume(20, 10, 6)
      expect(valueWithinTolerance(volumeOf(occ, scope, box), expected)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('cylinder: V = pi r^2 h', () => {
    const scope = new DisposeScope()
    try {
      const cylinder = scope.track(makeCylinder(occ, scope, [1, 2, 3], [0, 0, 1], 3, 7))
      const expected = cylinderVolume(3, 7)
      expect(valueWithinTolerance(volumeOf(occ, scope, cylinder), expected)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('revolve by Pappus, full turn: V = 2 pi d A (annulus of a rectangle)', () => {
    const scope = new DisposeScope()
    try {
      // The profile: x in [2, 5], z in [0, 4] in the XZ plane, so its centroid
      // sits at d = 3.5 from the z axis and A = 3 * 4.
      const profile = rectangularProfile(occ, scope, 2, 5, 0, 4)
      const solid = scope.track(revolveFace(occ, scope, profile, [0, 0, 0], [0, 0, 1], 360))
      const expected = pappusVolume(2 * Math.PI, 3.5, 12)
      expect(valueWithinTolerance(volumeOf(occ, scope, solid), expected)).toBe(true)
      // The washer form of the same number, as a second derivation.
      expect(expected).toBeCloseTo(Math.PI * (5 ** 2 - 2 ** 2) * 4, 12)
    } finally {
      scope.dispose()
    }
  })

  it('revolve by Pappus, partial turn: V = theta d A', () => {
    const scope = new DisposeScope()
    try {
      const profile = rectangularProfile(occ, scope, 2, 5, 0, 4)
      const degrees = 135
      const solid = scope.track(revolveFace(occ, scope, profile, [0, 0, 0], [0, 0, 1], degrees))
      const expected = pappusVolume((degrees * Math.PI) / 180, 3.5, 12)
      expect(valueWithinTolerance(volumeOf(occ, scope, solid), expected)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('filleted box: V = abc + 2(ab+bc+ca)r + pi(a+b+c)r^2 + (4/3)pi r^3', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 20, 10, 6))
      const edges = canonicalEdges(occ, scope, box)
      expect(edges).toHaveLength(12)
      const filleted = applyFilletWithDiff(occ, scope, box, 1.5, edges)
      expect(filleted.success).toBe(true)
      const rounded = scope.track(filleted.shape)
      const expected = filletVolume(20, 10, 6, 1.5)
      expect(valueWithinTolerance(volumeOf(occ, scope, rounded), expected)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('catches a shifted volume: the box measured times 1.001 is rejected', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 20, 10, 6))
      const shifted = volumeOf(occ, scope, box) * 1.001
      expect(valueWithinTolerance(shifted, boxVolume(20, 10, 6))).toBe(false)
    } finally {
      scope.dispose()
    }
  })

  // A planar rectangular face in the XZ plane: four straight edges around
  // (x0..x1, 0, z0..z1). Used as the Pappus profile.
  function rectangularProfile(
    occ2: OccModule,
    scope: DisposeScope,
    x0: number,
    x1: number,
    z0: number,
    z1: number,
  ): OccShape {
    const corner = (x: number, z: number): Vec3 => [x, 0, z]
    const points = [corner(x0, z0), corner(x1, z0), corner(x1, z1), corner(x0, z1)]
    const edges = points.map((start, i) => makeLineEdge(occ2, scope, start, points[(i + 1) % points.length]))
    const wire = makeWire(occ2, scope, edges)
    return makeFaceFromWire(occ2, scope, wire)
  }
})
