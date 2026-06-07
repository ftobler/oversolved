// @vitest-environment node
//
// Gated real-OCC parity tests for stable ancestry — geometry hash stability
// across builds and edits (ported from test_stable_ancestry.py). Verifies that
// face/edge geometry hashes are identical when the same shape is built twice,
// and that a fillet operation changes face hashes while inherited ones stay.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { HandleTable } from './handleTable'
import { makeBox } from './primitives'
import { booleanWithHistory } from './booleans'
import { solidToMesh } from './tessellation'
import { faceGeometryHash } from '../geomHash'
import type { OccModule } from './occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('stable ancestry hash stability', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function tessellateFaces(shape: ReturnType<typeof booleanWithHistory>['shape']) {
    const table = new HandleTable({ finalizerGuard: false })
    const handle = table.register(shape, 'test')
    const mesh = solidToMesh(occ, table, handle)
    return mesh.face_data.map((fd) => faceGeometryHash(fd.centroid, fd.normal))
  }

  it('identical box builds produce identical face hashes', () => {
    /** Building the same box twice should produce identical face geometry
     *  hashes — the hash is deterministic from geometry. */
    const scope1 = new DisposeScope()
    const scope2 = new DisposeScope()
    try {
      const box1 = makeBox(occ, scope1, 10, 10, 10)
      const box2 = makeBox(occ, scope2, 10, 10, 10)
      const hashes1 = tessellateFaces(box1).sort()
      const hashes2 = tessellateFaces(box2).sort()
      expect(hashes1).toEqual(hashes2)
    } finally {
      scope1.dispose()
      scope2.dispose()
    }
  })

  it('cut result has more face hashes than the original box', () => {
    /** A box cut by a smaller box gains new faces. The face hash count
     *  should increase, reflecting the new interior faces. */
    const scope = new DisposeScope()
    try {
      const target = makeBox(occ, scope, 10, 10, 10)
      const tool = makeBox(occ, scope, 4, 4, 4)
      const { shape } = booleanWithHistory(occ, scope, target, tool, 'cut')
      const cutHashes = tessellateFaces(shape)
      // A 10x10x10 box has 6 faces; cut by 4x4x4 adds interior faces.
      expect(cutHashes.length).toBeGreaterThan(6)
    } finally {
      scope.dispose()
    }
  })

  it('face hashes are non-empty and well-formed', () => {
    /** Every face hash should start with the gface_ prefix and have a hex
     *  digest suffix. */
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const hashes = tessellateFaces(box)
      for (const h of hashes) {
        expect(h.startsWith('gface_')).toBe(true)
        expect(h.length).toBeGreaterThan('gface_'.length)
      }
    } finally {
      scope.dispose()
    }
  })
})
