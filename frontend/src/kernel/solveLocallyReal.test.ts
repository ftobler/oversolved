// @vitest-environment node
//
// Real-OCC tests for ``extractBrepMetadata``: the mesh-free B-rep
// identification path in ``solveLocally.ts``. Drives the public export
// directly with known OCC shapes, verifying output structure, face/edge/
// vertex extraction, multiple-body handling, and error tolerance.
//
// Skips when opencascade.js is not installed.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { HandleTable } from './occ/handleTable'
import { DisposeScope } from './occ/disposeScope'
import { extractBrepMetadata } from './solveLocally'
import type { OccModule } from './occ/occTypes'
import type { OccHandle } from './occ/handleTable'
import type { Body } from './types3d'

const oc = await loadOcc()

describe.skipIf(!oc)('extractBrepMetadata (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function makeBody(id: string, createdBy: string, shapeHandle: OccHandle | null): Body {
    return {
      id,
      created_by: createdBy,
      modified_by: [],
      shape: shapeHandle,
      sketch_id: '',
      brep_diff: null,
      profile_queries: [],
      face_lineage: {},
      edge_lineage: {},
    }
  }

  function boxShape(scope: DisposeScope, table: HandleTable, w = 10, d = 10, h = 10, owner?: string): OccHandle {
    const maker = scope.track(new occ.BRepPrimAPI_MakeBox_1(w, d, h))
    return table.register(maker.Shape(), owner)
  }

  it('returns empty result for empty body store', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const result = extractBrepMetadata(occ, table, {})
    expect(result).toEqual({})
    table.assertNoLeaks()
  })

  it('skips bodies with null shape', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const bodyStore: Record<string, Body> = {
      body_null: makeBody('body_null', 'f1', null),
    }
    const result = extractBrepMetadata(occ, table, bodyStore)
    expect(result).toEqual({})
    table.assertNoLeaks()
  })

  it('skips a body then continues to the next when one shape fails', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new DisposeScope()

    // Stale handle: released before the call, so table.get throws.
    const staleHandle = boxShape(scope, table, 10, 10, 10, 'stale')
    table.release(staleHandle)

    const validHandle = boxShape(scope, table, 10, 10, 10, 'f2')

    const bodyStore: Record<string, Body> = {
      body_stale: makeBody('body_stale', 'f1', staleHandle),
      body_valid: makeBody('body_valid', 'f2', validHandle),
    }
    const result = extractBrepMetadata(occ, table, bodyStore)

    expect(result).not.toHaveProperty('body_stale')
    expect(result).toHaveProperty('body_valid')
    const entryV = result.body_valid as Record<string, unknown>
    expect((entryV.mesh as Record<string, unknown>).face_data as unknown[]).toHaveLength(6)

    table.release(validHandle)
    scope.dispose()
    table.assertNoLeaks()
  })

  it('extracts face metadata from a box body with empty geometry arrays', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new DisposeScope()
    const handle = boxShape(scope, table, 10, 10, 10, 'f1')

    const bodyStore: Record<string, Body> = {
      body_box: makeBody('body_box', 'f1', handle),
    }
    const result = extractBrepMetadata(occ, table, bodyStore)

    expect(result).toHaveProperty('body_box')
    const entry = result.body_box as Record<string, unknown>

    // mesh: empty geometry arrays, populated face metadata
    const mesh = entry.mesh as Record<string, unknown>
    expect(mesh.vertices).toEqual([])
    expect(mesh.faces).toEqual([])
    expect(mesh.triangle_to_face).toEqual([])
    expect(mesh.is_fallback).toBe(false)
    expect(mesh.face_data).toBeDefined()
    expect(Array.isArray(mesh.face_data)).toBe(true)
    // A box has 6 faces
    expect((mesh.face_data as unknown[]).length).toBe(6)
    expect(mesh.face_queries).toBeDefined()
    expect(Array.isArray(mesh.face_queries)).toBe(true)

    // Edges: populated (box has 12 edges)
    expect(entry.edges).toBeDefined()
    expect(Array.isArray(entry.edges)).toBe(true)
    expect(entry.edge_queries).toBeDefined()
    expect(Array.isArray(entry.edge_queries)).toBe(true)

    // Vertices: populated (box has 8 vertices)
    expect(entry.vertices).toBeDefined()
    expect(Array.isArray(entry.vertices)).toBe(true)
    expect(entry.vertex_queries).toBeDefined()
    expect(Array.isArray(entry.vertex_queries)).toBe(true)

    table.release(handle)
    scope.dispose()
    table.assertNoLeaks()
  })

  it('extracts per-face centroid/normal/surface_type/classifiers', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new DisposeScope()
    const handle = boxShape(scope, table, 10, 10, 10, 'f1')

    const bodyStore: Record<string, Body> = {
      body_box: makeBody('body_box', 'f1', handle),
    }
    const result = extractBrepMetadata(occ, table, bodyStore)
    const entry = result.body_box as Record<string, unknown>
    const mesh = entry.mesh as Record<string, unknown>
    const faceData = mesh.face_data as Array<Record<string, unknown>>

    expect(faceData).toHaveLength(6)
    for (const fd of faceData) {
      expect(fd).toHaveProperty('centroid')
      expect(Array.isArray(fd.centroid)).toBe(true)
      expect((fd.centroid as number[]).length).toBe(3)
      expect(fd).toHaveProperty('normal')
      expect(Array.isArray(fd.normal)).toBe(true)
      expect((fd.normal as number[]).length).toBe(3)
      expect(fd).toHaveProperty('surface_type')
      expect(fd).toHaveProperty('classifiers')
    }

    table.release(handle)
    scope.dispose()
    table.assertNoLeaks()
  })

  it('processes multiple bodies in the store', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new DisposeScope()
    const h1 = boxShape(scope, table, 10, 10, 10, 'f1')
    const h2 = boxShape(scope, table, 5, 5, 5, 'f2')

    const bodyStore: Record<string, Body> = {
      body_a: makeBody('body_a', 'f1', h1),
      body_b: makeBody('body_b', 'f2', h2),
    }
    const result = extractBrepMetadata(occ, table, bodyStore)

    expect(Object.keys(result)).toEqual(['body_a', 'body_b'])
    const entryA = result.body_a as Record<string, unknown>
    const entryB = result.body_b as Record<string, unknown>
    const facesA = (entryA.mesh as Record<string, unknown>).face_data as unknown[]
    const facesB = (entryB.mesh as Record<string, unknown>).face_data as unknown[]
    expect(facesA).toHaveLength(6)
    expect(facesB).toHaveLength(6)

    table.release(h1)
    table.release(h2)
    scope.dispose()
    table.assertNoLeaks()
  })

  it('handles body with face_lineage and edge_lineage', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const scope = new DisposeScope()
    const handle = boxShape(scope, table, 10, 10, 10, 'f1')

    const bodyStore: Record<string, Body> = {
      body_box: {
        id: 'body_box',
        created_by: 'f1',
        modified_by: [],
        shape: handle,
        sketch_id: '',
        brep_diff: null,
        profile_queries: [],
        face_lineage: { '@body_box/face0': ['sk1'] },
        edge_lineage: { '@body_box/edge0': ['sk1'] },
      },
    }
    const result = extractBrepMetadata(occ, table, bodyStore)

    expect(result).toHaveProperty('body_box')
    // The lineage fields do not affect the metadata shape; they just flow into
    // the classification step. Verify the entry still produces valid metadata.
    const entry = result.body_box as Record<string, unknown>
    expect((entry.mesh as Record<string, unknown>).face_data as unknown[]).toHaveLength(6)

    table.release(handle)
    scope.dispose()
    table.assertNoLeaks()
  })
})
