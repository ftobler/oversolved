// @vitest-environment node
//
// "Tessellation for eyes only" -- the mesh-free face identification path.
//
// readShapeFaceMetadata must produce the same face identification (order,
// classifiers, face_queries) as the render mesh, but WITHOUT triangulating.
// These tests pin both halves: zero BRepMesh calls during metadata extraction,
// and face_data/face_queries that match solidToMesh. Skips when opencascade.js
// is absent (npm run occ:install).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { HandleTable } from './handleTable'
import { DisposeScope } from './disposeScope'
import { buildBox, buildCylinder, buildExtrudedProfile } from './shapes'
import { solidToMesh, readShapeFaceMetadata } from './tessellation'
import { makeBox } from './primitives'
import { applyFilletWithDiff } from './edgeModifier'
import { faceGeometryHash } from '../geomHash'
import { parseAncestry } from '../query'
import type { OccModule, OccShape } from './occTypes'
import type { OccHandle } from './handleTable'
import type { Vec3 } from './primitives'

const oc = await loadOcc()

/** Run `fn` with BRepMesh_IncrementalMesh_2 swapped for a call-counting
 *  constructor, restoring it afterwards. Returns the number of triangulations. */
function countMeshCalls(occ: OccModule, fn: () => void): number {
  const ctor = occ.BRepMesh_IncrementalMesh_2
  let calls = 0
  ;(occ as unknown as Record<string, unknown>).BRepMesh_IncrementalMesh_2 = function (
    this: unknown,
    ...args: unknown[]
  ) {
    calls++
    return Reflect.construct(ctor as unknown as new (...a: unknown[]) => object, args)
  }
  try {
    fn()
  } finally {
    ;(occ as unknown as Record<string, unknown>).BRepMesh_IncrementalMesh_2 = ctor
  }
  return calls
}

describe.skipIf(!oc)('readShapeFaceMetadata: mesh-free face identification', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  // spec 1: metadata extraction never triangulates (and solidToMesh does, as a
  // control -- proving the counter actually observes BRepMesh).
  it('triangulates zero faces for box and cylinder, unlike solidToMesh', () => {
    const table = new HandleTable()
    const box = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    const cyl = buildCylinder(occ, table, { center: [0, 0, 0], axis: [0, 0, 1], radius: 3, height: 10 })
    try {
      for (const h of [box, cyl]) {
        const metaCalls = countMeshCalls(occ, () => {
          const scope = new DisposeScope()
          try {
            readShapeFaceMetadata(occ, scope, table.get(h))
          } finally {
            scope.dispose()
          }
        })
        expect(metaCalls).toBe(0)
        const meshCalls = countMeshCalls(occ, () => {
          solidToMesh(occ, table, h)
        })
        expect(meshCalls).toBeGreaterThan(0)
      }
    } finally {
      table.release(box)
      table.release(cyl)
      table.assertNoLeaks()
    }
  })

  // spec 2: same flat-before-curved (normal, centroid) face order as the render
  // mesh, so registration's face indices line up with the rendered body.
  it('produces face geometry in the same order as solidToMesh', () => {
    const table = new HandleTable()
    const cases: Record<string, OccHandle> = {
      box: buildBox(occ, table, { dx: 10, dy: 10, dz: 5 }),
      cylinder: buildCylinder(occ, table, { center: [0, 0, 0], axis: [0, 0, 1], radius: 3, height: 10 }),
      square: buildExtrudedProfile(occ, table, {
        loop: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]] as Vec3[],
        direction: [0, 0, 1],
        distance: 5,
      }),
    }
    try {
      for (const [name, h] of Object.entries(cases)) {
        const mesh = solidToMesh(occ, table, h)
        const scope = new DisposeScope()
        try {
          const meta = readShapeFaceMetadata(occ, scope, table.get(h))
          expect(meta.face_data.length, name).toBe(mesh.face_data.length)
          meta.face_data.forEach((fd, i) => {
            expect(fd.centroid, `${name} face ${i} centroid`).toEqual(mesh.face_data[i].centroid)
            expect(fd.normal, `${name} face ${i} normal`).toEqual(mesh.face_data[i].normal)
            expect(fd.surface_type, `${name} face ${i} type`).toBe(mesh.face_data[i].surface_type)
            expect(fd.classifiers, `${name} face ${i} cls`).toEqual(mesh.face_data[i].classifiers)
          })
        } finally {
          scope.dispose()
        }
      }
    } finally {
      for (const h of Object.values(cases)) table.release(h)
      table.assertNoLeaks()
    }
  })

  // Invariant guard (code review of b081b76): the metadata path keeps the same
  // face count as the render mesh. assembleMesh DROPS zero-triangle faces and
  // this path does not, so they agree only because every face triangulates;
  // _snapshotWithBrepGeometry keys checkpoint eviction on the face index, so a
  // divergence here would corrupt the checkpoint snapshot. A filleted box adds a
  // curved face and small new edges -- the most likely place a degenerate face
  // would surface.
  it('keeps face count in sync with the render mesh, including a filleted box', () => {
    const table = new HandleTable()
    const scope = new DisposeScope()
    let filleted: OccHandle | null = null
    try {
      const box = makeBox(occ, scope, 10, 10, 5)
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(box, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      const edge = scope.track(occ.TopoDS.Edge_1(exp.Current())) as OccShape
      const res = applyFilletWithDiff(occ, scope, box, 1, [edge])
      expect(res.success).toBe(true)
      filleted = table.register(res.shape)

      const mesh = solidToMesh(occ, table, filleted)
      const innerScope = new DisposeScope()
      try {
        const meta = readShapeFaceMetadata(occ, innerScope, table.get(filleted))
        expect(meta.face_data.length).toBe(mesh.face_data.length)
      } finally {
        innerScope.dispose()
      }
    } finally {
      scope.dispose()
      if (filleted != null) table.release(filleted)
      table.assertNoLeaks()
    }
  })

  // spec 3: identical face_queries with and without the mesh, for an identified
  // body. This is what a picked face resolves against, so it must not depend on
  // triangulation.
  it('emits face_queries identical to solidToMesh for an identified box', () => {
    const table = new HandleTable()
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    const opts = { createdBy: 'ex1', bodyId: 'body_ex1', profileQueries: ['@sk1/line1'] }
    try {
      const mesh = solidToMesh(occ, table, h, opts)
      const scope = new DisposeScope()
      try {
        const meta = readShapeFaceMetadata(occ, scope, table.get(h), opts)
        expect(meta.face_queries).toEqual(mesh.face_queries)
        expect(meta.face_queries.length).toBe(6)
      } finally {
        scope.dispose()
      }
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  // spec 4: `face_queries` must stay aligned with `face_data` even when
  // `buildFaceQuery` returns null for every face (no `createdBy` passed, the
  // exact call shape spec 1 above uses). `extractBodyAnchors` zips the two by
  // index; a `face_queries` shorter than `face_data` would shift every anchor
  // past the gap onto another face's geometry instead of just skipping the
  // face with no query.
  it('keeps face_queries and face_data the same length when no face has a query', () => {
    const table = new HandleTable()
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    try {
      const mesh = solidToMesh(occ, table, h)  // no createdBy -> every query is null
      expect(mesh.face_queries.length).toBe(mesh.face_data.length)
      expect(mesh.face_queries.length).toBe(6)

      const scope = new DisposeScope()
      try {
        const meta = readShapeFaceMetadata(occ, scope, table.get(h))
        expect(meta.face_queries.length).toBe(meta.face_data.length)
        expect(meta.face_queries.length).toBe(6)
      } finally {
        scope.dispose()
      }
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })

  // spec 5: a face whose ancestry token list is an EMPTY array (a prism cap
  // face) must be treated as having no ancestry, so the emitted query falls
  // back to the profile tokens exactly as the builder's registered key does.
  // classifyFace used to read `[]` as truthy, nulling the profile fallback and
  // emitting a bare createdBy+bodyId net -- a stale cap UUID then had no
  // ancestral recovery.
  it('treats an empty faceAncestry list as absent and falls back to the profile tokens', () => {
    const table = new HandleTable()
    const h = buildBox(occ, table, { dx: 10, dy: 10, dz: 5 })
    try {
      const mesh = solidToMesh(occ, table, h)
      const capIdx = mesh.face_data.findIndex((fd) => fd.normal[2] > 0.9)
      const sideIdx = mesh.face_data.findIndex((fd) => Math.abs(fd.normal[2]) < 0.1 && fd.normal[0] > 0.9)
      expect(capIdx).toBeGreaterThanOrEqual(0)
      expect(sideIdx).toBeGreaterThanOrEqual(0)
      const cap = mesh.face_data[capIdx]
      const side = mesh.face_data[sideIdx]
      const capUuid = 'u_cap'
      const sideUuid = 'u_side'
      const opts = {
        createdBy: 'ex1',
        bodyId: 'body_ex1',
        profileQueries: ['@sk1/bottom', '@sk1/top'],
        faceNames: {
          [faceGeometryHash(cap.centroid, cap.normal)]: capUuid,
          [faceGeometryHash(side.centroid, side.normal)]: sideUuid,
        },
        faceAncestry: {
          [capUuid]: [],
          [sideUuid]: ['@sk1/bottom'],
        },
      }
      const out = solidToMesh(occ, table, h, opts)
      const [capIds] = parseAncestry(out.face_queries[capIdx])
      expect(capIds, 'empty ancestry list must fall back to the profile tokens').toEqual(
        expect.arrayContaining(['@ex1', '@body_ex1', '@sk1/bottom', '@sk1/top']),
      )
      const [sideIds] = parseAncestry(out.face_queries[sideIdx])
      expect(sideIds, 'real ancestry tokens must win over the profile tokens').toEqual(
        expect.arrayContaining(['@ex1', '@body_ex1', '@sk1/bottom']),
      )
      expect(sideIds).not.toEqual(expect.arrayContaining(['@sk1/top']))
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })
})
