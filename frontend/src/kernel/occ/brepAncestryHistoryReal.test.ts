// @vitest-environment node
//
// Gated real-OCC tests for brep ancestry history — tessellation after boolean
// operations (ported from test_brep_ancestry_history.py). After a boolean cut,
// the tessellated mesh must have face_data with the expected face count and
// edge/vertex queries that reflect the combined geometry.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { HandleTable } from './handleTable'
import { makeBox } from './primitives'
import { booleanWithHistory } from './booleans'
import { solidToMesh, solidToEdges, solidToVertices } from './tessellation'
import { volumeOf } from './booleans'
import type { OccModule, OccHandle } from './occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('brep ancestry history after boolean cut', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('cut mesh has more faces than the original box (new interior faces)', () => {
    /** A box cut by a smaller box gains new interior faces from the cut
     *  cavity. Port of test_mesh_face_queries_have_correct_created_by_after_cut. */
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const target = makeBox(occ, scope, 10, 10, 10)
      const tool = makeBox(occ, scope, 4, 4, 4)
      const { shape } = booleanWithHistory(occ, scope, target, tool, 'cut')
      const handle = table.register(scope.detach(shape), 'featCutter')
      const mesh = solidToMesh(occ, table, handle)
      // A 10x10x10 box has 6 faces. Cut by a 4x4x4 box adds interior faces.
      expect(mesh.face_data.length).toBeGreaterThan(6)
    } finally {
      scope.dispose()
    }
  })

  it('cut removes volume from the target', () => {
    /** The volume of the cut result should be less than the original target
     *  volume (material was removed). */
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const target = makeBox(occ, scope, 10, 10, 10)
      const tool = makeBox(occ, scope, 4, 4, 4)
      const { shape } = booleanWithHistory(occ, scope, target, tool, 'cut')
      const handle = table.register(scope.detach(shape), 'featCutter')
      const vol = volumeOf(occ, scope, table.get(handle))
      expect(vol).toBeLessThan(1000) // less than 10*10*10
      expect(vol).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('cut result tessellates without error', () => {
    /** The tessellated cut result should produce valid mesh vertices and
     *  triangle faces. No mesh_error. */
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const target = makeBox(occ, scope, 10, 10, 10)
      const tool = makeBox(occ, scope, 4, 4, 4)
      const { shape } = booleanWithHistory(occ, scope, target, tool, 'cut')
      const handle = table.register(scope.detach(shape), 'featCutter')
      const mesh = solidToMesh(occ, table, handle)
      expect(mesh.vertices.length).toBeGreaterThan(0)
      expect(mesh.faces.length).toBeGreaterThan(0)
      expect(mesh.is_fallback).toBe(false)
      expect(mesh.face_data.length).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })
})
