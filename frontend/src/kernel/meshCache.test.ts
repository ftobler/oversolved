// @vitest-environment node
//
// Cross-solve mesh cache: clean prefix, cache hit/miss, pick bodies, fallback, parallel
// determinism.
//
// Tests 1–6, 10 require full OCC-backed feature solvers (sketch, extrude, fillet, boolean) not
// yet ported to TS, plus real solid_to_mesh for unittest.mock-style counting. They will be
// ported when the leaf feature solvers land (phase 2e/2f).
//
// Test 3 (pick_bodies served from checkpoint) and test 8 (stale buildstate without
// bodies_snapshot) are already covered by builder.test.ts: - "supports pick_boundary returning
// pick_bodies" (L196) - "re-tessellates pick_bodies when bodies_snapshot is empty" (L295)

import { describe, it, expect, beforeAll } from 'vitest'
import { build, type BuildDeps, type FeatureResult } from './builder'
import { Repository } from './query'
import { loadOcc } from './occ/loadOcc'
import { HandleTable } from './occ/handleTable'
import { DisposeScope } from './occ/disposeScope'
import { makeBox } from './occ/primitives'
import { volumeOf } from './occ/booleans'
import type { OccModule } from './occ/occTypes'
import type { Body } from './types3d'

const oc = await loadOcc()

function makeDeps(overrides?: Partial<BuildDeps>): BuildDeps {
  return {
    trySolveFeature: (_feature, _repo, _bodyStore, _featuresById): FeatureResult => ({ status: 'ok' }),
    postRegister: () => {},
    initGlobalRepo: () => new Repository(),
    tessellateBodies: () => ({}),
    ...overrides,
  }
}

function makeBody(id: string, createdBy: string): Body {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: 1 as unknown as Body['shape'], // non-null to trigger B-rep registration
    sketch_id: '',
    brep_diff: null,
    profile_queries: [],
  }
}

// ─── Test 9: lazy checkpoint meshing contract — regression guard ───

/**
 * Under lazy checkpoint meshing only the FINAL feature's checkpoint carries a
 * render mesh (bodies_snapshot keys matching its body_store_snapshot); every
 * earlier checkpoint stays lazy with an empty bodies_snapshot, tessellated on
 * demand by the pick path. This guards the O(N)->O(1) tessellation reduction.
 */
describe('lazy checkpoint meshing contract', () => {
  const trySolveFeature = (feature: Record<string, unknown>, _repo: Repository, bodyStore: Record<string, Body>): FeatureResult => {
    if (String(feature.kind) === 'extrude') {
      const bid = 'body_' + String(feature.id)
      bodyStore[bid] = makeBody(bid, String(feature.id))
    }
    return { status: 'ok' }
  }

  it('only the final checkpoint carries a bodies_snapshot; earlier ones are empty', () => {
    const deps = makeDeps({ trySolveFeature })
    const spec: Record<string, unknown> = {
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
        { id: 'ex2', kind: 'extrude' },
      ],
    }
    const r = build(spec, {}, deps)
    const order = r._build_state.feature_order
    const lastFid = order[order.length - 1]

    for (const [fid, cp] of Object.entries(r._build_state.checkpoints)) {
      const bs = cp.bodies_snapshot as Record<string, unknown>
      expect(typeof bs, `checkpoint ${fid}: bodies_snapshot is ${typeof bs}`).toBe('object')
      if (fid === lastFid) {
        for (const bid of Object.keys(cp.body_store_snapshot)) {
          expect(bid in bs, `final checkpoint ${fid}: body ${bid} missing`).toBe(true)
        }
      } else {
        expect(Object.keys(bs).length, `intermediate checkpoint ${fid} should be lazy`).toBe(0)
      }
    }
  })

  it('keeps the contract through an incremental rebuild (clean prefix stays lazy)', () => {
    const deps = makeDeps({ trySolveFeature })
    const spec: Record<string, unknown> = {
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
        { id: 'ex2', kind: 'extrude' },
      ],
    }

    const r1 = build(spec, {}, deps)

    // Edit last feature; sk1 and ex1 form the clean prefix.
    const spec2 = {
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
        { id: 'ex2', kind: 'extrude', label: 'changed' },
      ],
    }
    const r2 = build(spec2, { prevState: r1._build_state }, deps)

    // Clean prefix checkpoints (carried from prev_state) are intermediate, so lazy.
    for (const fid of ['sk1', 'ex1']) {
      const cp = r2._build_state.checkpoints[fid]
      expect(cp).toBeDefined()
      expect(Object.keys(cp.bodies_snapshot as object).length,
        `clean prefix checkpoint ${fid} should be lazy`).toBe(0)
    }

    // The dirty final checkpoint (ex2) carries the render mesh.
    const cpEx2 = r2._build_state.checkpoints['ex2']
    for (const bid of Object.keys(cpEx2.body_store_snapshot)) {
      expect(bid in (cpEx2.bodies_snapshot as object),
        `final checkpoint ex2: body ${bid} missing`).toBe(true)
    }
  })
})

// ─── Test 7: parallel mesh deterministic ───

/** Meshing with in_parallel=True vs False yields identical geometry. */
describe.skipIf(!oc)('parallel mesh deterministic (OCC.js)', () => {
  let occ: OccModule

  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  it('serial and parallel meshing yield identical volume', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new DisposeScope()

    try {
      const boxSerial = makeBox(occ, scope, 10, 10, 5)
      const boxParallel = makeBox(occ, scope, 10, 10, 5)

      // Serial mesh
      scope.track(new occ.BRepMesh_IncrementalMesh_2(boxSerial, 0.1, false, 0.1, false))
      const volSerial = volumeOf(occ, scope, boxSerial)

      // Parallel mesh
      scope.track(new occ.BRepMesh_IncrementalMesh_2(boxParallel, 0.1, false, 0.1, true))
      const volParallel = volumeOf(occ, scope, boxParallel)

      expect(Math.abs(volSerial - volParallel)).toBeLessThan(1e-6)
      expect(volSerial).toBeGreaterThan(0)
      expect(volParallel).toBeGreaterThan(0)
    } finally {
      scope.dispose()
      table.assertNoLeaks()
    }
  })

})

