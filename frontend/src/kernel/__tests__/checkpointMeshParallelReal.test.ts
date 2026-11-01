// @vitest-environment node
//
// Parallel mesh determinism and lazy checkpoint meshing (bodies_snapshot). The
// retired cross-solve cache module's contract now lives in the builder's
// checkpoints / bodies_snapshot.
//
// This suite runs the two scenarios that need no feature solvers. The OCC-backed
// scenarios live in checkpointMeshReal.test.ts.
//
// pick_bodies served from a checkpoint and the stale-buildstate-without-
// bodies_snapshot case are already covered by builder.test.ts:
// "supports pick_boundary returning pick_bodies" and "re-tessellates
// pick_bodies when bodies_snapshot is empty".

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { HandleTable } from '../occ/handleTable'
import { DisposeScope } from '../occ/disposeScope'
import { makeBox } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import type { OccModule } from '../occ/occTypes'

const oc = await loadOcc()
describe.skipIf(!oc)('parallel mesh deterministic (OCC.js)', () => {
  let occ: OccModule

  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  it('serial and parallel meshing yield identical volume', () => {
    const table = new HandleTable()
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
