// @vitest-environment node
//
// The kernel half of the solver/kernel precision contract: the face merge reads
// a named tolerance pair instead of whatever OCC happens to have compiled in,
// and widens by what the sketch solver reported, up to a ceiling.
//
// Real-OCC tests (skipped without the optional opencascade.js install):
// - the two setters are called with the contract pair when nothing is inherited;
// - two coplanar-ish boxes whose tops differ by 5e-11 rad stay two faces at the
//   contract and merge into one at an inherited 1e-10;
// - a 5e-9 rad crease with an inherited 5e-9 merges at most at the 1e-9 ceiling,
//   so the faces stay split and the caller has a warning to emit;
// - the whole boolean pipeline (`booleanWithDiff`) carries an inherited record
//   into its clean, which is the path the feature builders take.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBoxAt, faceNormal } from '../primitives'
import { booleanWithDiff, booleanWithHistory, cleanWithHistory, countSubShapes } from '../booleans'
import { makeRotationTrsf, transformCopy } from '../transforms'
import { OCC_ANGULAR, OCC_CONFUSION, TOL_SURFACE_PARALLEL } from '../../solverConstants'
import { mergeTolerance, precisionCeilingWarning } from '../../precision'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

/** The unit normals of every planar face of `shape`. */
function planarNormals(oc2: OccModule, scope: DisposeScope, shape: OccShape): number[][] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: number[][] = []
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc2.TopoDS.Face_1(scope.track(exp.Current())))
    try {
      out.push([...faceNormal(oc2, scope, face)])
    } catch {
      // A curved face has no UV-midpoint normal to read; not a top candidate.
    }
  }
  return out
}

/** How many faces point up (+Z): one box top, or two when a seam keeps the
 *  halves apart. */
function topFaces(oc2: OccModule, scope: DisposeScope, shape: OccShape): number {
  return planarNormals(oc2, scope, shape).filter((n) => n[2] > 1 - 1e-6).length
}

/**
 * Two 10x10x10 boxes that touch at x = 10, the right one rotated by `theta`
 * about the Y axis through the shared top edge (10, *, 10). Their top planes
 * therefore differ by exactly `theta`: a coplanar-ish pair the clean can fold
 * when it is allowed to read that angle.
 */
function tiltedPair(oc2: OccModule, scope: DisposeScope, theta: number): OccShape {
  const left = scope.track(makeBoxAt(oc2, scope, [0, 0, 0], 10, 10, 10))
  const right = scope.track(makeBoxAt(oc2, scope, [10, 0, 0], 10, 10, 10))
  const trsf = makeRotationTrsf(oc2, scope, [10, 0, 10], [0, 1, 0], theta)
  const tilted = scope.track(transformCopy(oc2, scope, right, trsf))
  return scope.track(booleanWithHistory(oc2, scope, left, tilted, 'fuse').shape)
}

describe('cleanWithHistory reads a named tolerance pair', () => {
  // A fake ShapeUpgrade_UnifySameDomain that records the calls in order.
  function spyModule(calls: string[]): { oc: OccModule; shape: OccShape } {
    const shape = { delete: () => {} } as unknown as OccShape
    const history = { delete: () => {} }
    const up = {
      SetLinearTolerance: (t: number) => { calls.push(`linear:${t}`) },
      SetAngularTolerance: (t: number) => { calls.push(`angular:${t}`) },
      AllowInternalEdges: () => {},
      Build: () => { calls.push('build') },
      Shape: () => shape,
      History_1: () => ({ get: () => history, delete: () => {} }),
      delete: () => {},
    }
    const ocFake = {
      ShapeUpgrade_UnifySameDomain_2: function () { return up },
    } as unknown as OccModule
    return { oc: ocFake, shape }
  }

  it('always sets both, before Build, at the contract pair by default', () => {
    const calls: string[] = []
    const { oc: ocFake, shape } = spyModule(calls)
    const scope = new DisposeScope()
    try {
      cleanWithHistory(ocFake, scope, shape)
    } finally {
      scope.dispose()
    }
    expect(calls).toEqual([
      `linear:${OCC_CONFUSION}`, `angular:${OCC_ANGULAR}`, 'build',
    ])
  })

  it('sets exactly the tolerances it is handed', () => {
    const calls: string[] = []
    const { oc: ocFake, shape } = spyModule(calls)
    const scope = new DisposeScope()
    try {
      cleanWithHistory(ocFake, scope, shape, true, { linearTol: 2e-7, angularTol: 3e-10 })
    } finally {
      scope.dispose()
    }
    expect(calls).toEqual(['linear:2e-7', 'angular:3e-10', 'build'])
  })

  it('the real build binds both setters on ShapeUpgrade_UnifySameDomain', () => {
    if (!oc) return
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBoxAt(oc, scope, [0, 0, 0], 1, 1, 1))
      const up = scope.track(new oc.ShapeUpgrade_UnifySameDomain_2(box, true, true, true))
      const probe = up as unknown as Record<string, unknown>
      expect(typeof probe.SetLinearTolerance).toBe('function')
      expect(typeof probe.SetAngularTolerance).toBe('function')
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!oc)('cleanWithHistory against the real kernel', () => {
  it('merges a 5e-11 crease only once the inherited precision reaches it', () => {
    const scope = new DisposeScope()
    try {
      const fused = tiltedPair(oc!, scope, 5e-11)
      // The raw fuse keeps the two tops apart: the BOP reads OCC's own 1e-12.
      expect(topFaces(oc!, scope, fused)).toBe(2)
      // No inherited precision: the clean reads the contract pair (1e-12 rad), so
      // a 5e-11 crease is still a crease.
      const atContract = scope.track(cleanWithHistory(oc!, scope, fused, true).shape)
      expect(topFaces(oc!, scope, atContract)).toBe(2)
      // The solver reported 1e-10 (or better): the same clean folds the pair.
      const widened = scope.track(cleanWithHistory(oc!, scope, fused, true, mergeTolerance({
        angular: 1e-10, linear: OCC_CONFUSION,
      })).shape)
      expect(topFaces(oc!, scope, widened)).toBe(1)
      expect(countSubShapes(oc!, scope, widened, oc!.TopAbs_ShapeEnum.TopAbs_FACE)).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('runs at the ceiling for a 5e-9 crease and warns instead of folding it', () => {
    const scope = new DisposeScope()
    try {
      const fused = tiltedPair(oc!, scope, 5e-9)
      const inherited = { angular: 5e-9, linear: OCC_CONFUSION, sketch: 'sk1' }
      const tolerance = mergeTolerance(inherited)
      // The merge is clamped to the "same analytic axis" rung, not the report.
      expect(tolerance.angularTol).toBe(TOL_SURFACE_PARALLEL)
      expect(tolerance.ceilingMiss).toEqual({ angular: true, linear: false })
      const clamped = scope.track(cleanWithHistory(oc!, scope, fused, true, tolerance).shape)
      expect(topFaces(oc!, scope, clamped)).toBe(2)
      // Control: the report's own width WOULD fold it, so the split above is the
      // ceiling at work and not a clean that cannot merge this pair at all.
      const unfolded = scope.track(cleanWithHistory(oc!, scope, fused, true, {
        angularTol: 5e-9, linearTol: OCC_CONFUSION,
      }).shape)
      expect(topFaces(oc!, scope, unfolded)).toBe(1)
      // The feature has something to say about the seam it could not close.
      expect(precisionCeilingWarning(inherited)).toContain(
        "sketch sk1 solved to 5e-9 rad, above the kernel's 1e-9 merge ceiling",
      )
    } finally {
      scope.dispose()
    }
  })

  it('carries the inherited precision through booleanWithDiff', () => {
    const scope = new DisposeScope()
    try {
      const left = scope.track(makeBoxAt(oc!, scope, [0, 0, 0], 10, 10, 10))
      const right = scope.track(makeBoxAt(oc!, scope, [10, 0, 0], 10, 10, 10))
      const trsf = makeRotationTrsf(oc!, scope, [10, 0, 10], [0, 1, 0], 5e-11)
      const tilted = scope.track(transformCopy(oc!, scope, right, trsf))
      const plain = scope.track(booleanWithDiff(oc!, scope, left, tilted, 'fuse').shape)
      expect(topFaces(oc!, scope, plain)).toBe(2)
      const widened = scope.track(booleanWithDiff(oc!, scope, left, tilted, 'fuse', {
        precision: { angular: 1e-10, linear: OCC_CONFUSION },
      }).shape)
      expect(topFaces(oc!, scope, widened)).toBe(1)
    } finally {
      scope.dispose()
    }
  })

  it('does not start folding a deliberate 1e-6 tilt at the contract', () => {
    // The "free tilt stays split" kernel form: an inherited record inside the
    // contract is no licence to fold a crease the solver never measured.
    const scope = new DisposeScope()
    try {
      const fused = tiltedPair(oc!, scope, 1e-6)
      const narrowed = scope.track(cleanWithHistory(oc!, scope, fused, true, mergeTolerance({
        angular: OCC_ANGULAR, linear: OCC_CONFUSION,
      })).shape)
      expect(topFaces(oc!, scope, narrowed)).toBe(2)
    } finally {
      scope.dispose()
    }
  })
})
