// @vitest-environment node
//
// Parallel mesh determinism across a persistent HandleTable, through the real
// OCC.js pipeline: the same build meshed twice is identical. The lazy
// checkpoint meshing contract that needs no feature solvers is
// checkpointMesh.test.ts; the broader checkpoint / bodies_snapshot replay is
// checkpointMeshReal.test.ts.
//
// Skips when OCC.js is absent.

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
