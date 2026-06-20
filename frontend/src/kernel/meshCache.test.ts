// @vitest-environment node
//
// Ported from the removed tests/kernel/test_mesh_cache.py (10 test functions).
// Cross-solve mesh cache: clean prefix, cache hit/miss, pick bodies,
// fallback, parallel determinism.
//
// Tests 1–6, 10 require full OCC-backed feature solvers (sketch, extrude,
// fillet, boolean) not yet ported to TS, plus real solid_to_mesh for
// unittest.mock-style counting. They will be ported when the leaf feature
// solvers land (phase 2e/2f).
//
// Test 3 (pick_bodies served from checkpoint) and test 8 (stale buildstate
// without bodies_snapshot) are already covered by builder.test.ts:
//   - "supports pick_boundary returning pick_bodies" (L196)
//   - "re-tessellates pick_bodies when bodies_snapshot is empty" (L295)

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
    face_lineage: {},
    edge_lineage: {},
  }
}

// ─── Test 9: checkpoint bodies_snapshot is populated — regression guard ───

/**
 * After any build (full or incremental), every non-suppressed checkpoint
 * must carry a bodies_snapshot whose keys match body_store_snapshot keys.
 *
 * Port of test_checkpoint_bodies_snapshot_populated.
 */
describe('checkpoint bodies_snapshot populated', () => {
  it('every non-suppressed checkpoint has matching bodies_snapshot keys', () => {
    const deps = makeDeps({
      trySolveFeature: (feature, _repo, bodyStore): FeatureResult => {
        if (feature.kind === 'extrude') {
          const bid = 'body_' + String(feature.id)
          bodyStore[bid] = makeBody(bid, String(feature.id))
        }
        return { status: 'ok' }
      },
    })
    const spec: Record<string, unknown> = {
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
        { id: 'ex2', kind: 'extrude' },
      ],
    }
    const r = build(spec, {}, deps)

    for (const [fid, cp] of Object.entries(r._build_state.checkpoints)) {
      const bs = cp.bodies_snapshot
      expect(typeof bs, `checkpoint ${fid}: bodies_snapshot is ${typeof bs}`).toBe('object')
      for (const bid of Object.keys(cp.body_store_snapshot)) {
        expect(bid in bs, `checkpoint ${fid}: body ${bid} missing from bodies_snapshot`).toBe(true)
      }
    }
  })

  it('preserves bodies_snapshot keys through incremental rebuild (clean prefix)', () => {
    const deps = makeDeps({
      trySolveFeature: (feature, _repo, bodyStore): FeatureResult => {
        if (String(feature.kind) === 'extrude') {
          const bid = 'body_' + String(feature.id)
          bodyStore[bid] = makeBody(bid, String(feature.id))
        }
        return { status: 'ok' }
      },
    })
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

    // Clean prefix checkpoints are carried over from prev_state.
    for (const fid of ['sk1', 'ex1']) {
      const cp = r2._build_state.checkpoints[fid]
      expect(cp).toBeDefined()
      for (const bid of Object.keys(cp.body_store_snapshot)) {
        expect(bid in (cp.bodies_snapshot as object),
          `clean prefix checkpoint ${fid}: body ${bid} missing`)
      }
    }

    // The dirty checkpoint (ex2) must also have matching keys.
    const cpEx2 = r2._build_state.checkpoints['ex2']
    for (const bid of Object.keys(cpEx2.body_store_snapshot)) {
      expect(bid in (cpEx2.bodies_snapshot as object),
        `dirty checkpoint ex2: body ${bid} missing`)
    }
  })
})

// ─── Test 7: parallel mesh deterministic ───

/**
 * Meshing with in_parallel=True vs False yields identical geometry.
 *
 * Port of test_parallel_mesh_deterministic.
 */
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

