// @vitest-environment node
//
// Gated real-OCC end-to-end test for the shell LEAF (features/shell.ts): the
// face index build, construction-based face resolution, the OCC thick-solid
// call, naming, and the in-place body-store update. The OCC producer's own
// history is pinned by occ/__tests__/thickSolidProbeReal.test.ts; here the leaf
// is threaded a real named body.
//
// Faces are addressed by their construction-UUID query (the wire form the
// viewport mints), so the test does not depend on cross-build face enumeration
// order beyond the body it builds itself.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, makeCylinderWithFaces, faceCentroid } from '../../occ/primitives'
import { volumeOf, surfaceAreaOf } from '../../occ/volume'
import { canonicalEdges, canonicalFaces, namesFromArray, namesToArray } from '../../occ/bodyNames'
import { deriveEdgeNames } from '../../occ/constructionLineage'
import { ref, Repository, makeAncestryQuery, constructionUuidToken } from '../../query'
import { solveShell } from '../shell'
import { solveFillet } from '../filletChamfer'
import { exploreEdges } from '../../occ/edgeModifier'
import { buildFaceIndex } from '../shared/faceResolution'
import { mintFaceUuid, shellFacePath } from '../../constructionName'
import type { Body } from '../../types3d'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'

const oc = await loadOcc()

const FACE_TYPE = 'flatface'

/** A face pick query for the face that carries `uuid`. */
const faceQuery = (uuid: string): string => makeAncestryQuery([constructionUuidToken(uuid)], FACE_TYPE)

describe.skipIf(!oc)('solveShell leaf (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  // A named 10-millimetre box body: faces `f0..f5` in canonical order.
  function boxBody(scope: DisposeScope, table: HandleTable, size = 10): Record<string, Body> {
    const box = makeBox(occ, scope, size, size, size)
    const faces = canonicalFaces(occ, scope, box)
    const face_uuids = faces.map((_, i) => `f${i}`)
    const faceAncestry = Object.fromEntries(face_uuids.map((u) => [u, [ref('ex1'), ref('body_b')]]))
    const { edgeNames, edgeAncestry } = deriveEdgeNames(occ, scope, box, namesFromArray(faces, face_uuids), faceAncestry)
    const edge_uuids = namesToArray(canonicalEdges(occ, scope, box), edgeNames)
    return {
      body_b: {
        id: 'body_b', created_by: 'ex1', modified_by: [],
        shape: table.register(box, 'ex1'), sketch_id: 'sk', brep_diff: null,
        profile_queries: [], face_uuids, edge_uuids, face_ancestry: faceAncestry, edge_ancestry: edgeAncestry,
      },
    }
  }

  // The canonical index of the body shape top face (max centroid Z).
  function topFaceIndex(scope: DisposeScope, table: HandleTable, body: Body): number {
    const faces = canonicalFaces(occ, scope, table.get<OccShape>(body.shape!))
    let best = 0
    faces.forEach((f, i) => {
      if (faceCentroid(occ, scope, f as never)[2] > faceCentroid(occ, scope, faces[best] as never)[2]) best = i
    })
    return best
  }

  // The canonical index of the body shape bottom face (min centroid Z).
  function bottomFaceIndex(scope: DisposeScope, table: HandleTable, body: Body): number {
    const faces = canonicalFaces(occ, scope, table.get<OccShape>(body.shape!))
    let best = 0
    faces.forEach((f, i) => {
      if (faceCentroid(occ, scope, f as never)[2] < faceCentroid(occ, scope, faces[best] as never)[2]) best = i
    })
    return best
  }

  function shelledShape(_scope: DisposeScope, table: HandleTable, body: Body): OccShape {
    return table.get<OccShape>(body.shape!)
  }

  it('top open inward t=1: V=424, A=888, 11 faces, 24 edges, bbox unchanged', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      const shape = shelledShape(scope, table, body)
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(424, 4)
      expect(surfaceAreaOf(occ, scope, shape)).toBeCloseTo(888, 4)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(11)
      expect(canonicalEdges(occ, scope, shape)).toHaveLength(24)
      expect(body.modified_by).toEqual(['sh1'])
      expect(body.brep_diff?.new_faces.length).toBeGreaterThan(0)
      // Inward removes material inside the original skin, so the bbox holds.
      const box = scope.track(new occ.Bnd_Box_1())
      occ.BRepBndLib.Add(shape, box, false)
      expect([box.GetXmin(), box.GetYmin(), box.GetZmin(), box.GetXmax(), box.GetYmax(), box.GetZmax()].map((n) => Math.round(n)))
        .toEqual([0, 0, 0, 10, 10, 10])
    } finally {
      scope.dispose()
    }
  })

  it('no faces inward t=1: V=488, one body, 12 faces (closed hollow)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const originalUuids = [...body.face_uuids!]
      const bottomUuid = body.face_uuids![bottomFaceIndex(scope, table, body)]!
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [], thickness: 1, source_body: '@body_b' } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(res.body_ids).toEqual(['body_b'])
      const shape = shelledShape(scope, table, bodyStore.body_b)
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(488, 4)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(12)
      // Every result face is named; the outer skin keeps the original UUIDs and
      // the inner void mints an offset name keyed off each source face.
      expect(body.face_uuids!.every((u) => u !== null)).toBe(true)
      for (const u of originalUuids) expect(body.face_uuids).toContain(u)
      expect(body.face_uuids).toContain(mintFaceUuid(shellFacePath('sh1', 'offset', bottomUuid)))
    } finally {
      scope.dispose()
    }
  })

  it('top open outward t=1: V=584, bbox grows by 1 each way, sharp corners (11 faces)', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const topUuid = body.face_uuids![topFaceIndex(scope, table, body)]!
      const keptUuids = body.face_uuids!.filter((u) => u !== topUuid)
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 1, direction: 'outward' } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      const shape = shelledShape(scope, table, body)
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(584, 4)
      expect(canonicalFaces(occ, scope, shape)).toHaveLength(11)
      const box = scope.track(new occ.Bnd_Box_1())
      occ.BRepBndLib.Add(shape, box, false)
      expect([box.GetXmin(), box.GetYmin(), box.GetZmin(), box.GetXmax(), box.GetYmax(), box.GetZmax()].map((n) => Math.round(n)))
        .toEqual([-1, -1, -1, 11, 11, 10])
      // Outward names the same way as inward: the kept inner skin carries the
      // old UUIDs (minus the removed top) and every kept face mints its offset
      // wall keyed off the source face.
      expect(body.face_uuids!.every((u) => u !== null)).toBe(true)
      for (const u of keptUuids) {
        expect(body.face_uuids).toContain(u)
        expect(body.face_uuids).toContain(mintFaceUuid(shellFacePath('sh1', 'offset', u!)))
      }
    } finally {
      scope.dispose()
    }
  })

  it('two opposite faces open makes a tube: V=360', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const qs = body.face_uuids!.slice(0, 2).map((u) => faceQuery(u!))
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: qs, thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(volumeOf(occ, scope, shelledShape(scope, table, body))).toBeCloseTo(360, 4)
    } finally {
      scope.dispose()
    }
  })

  it('cylinder r=5 h=10 top open inward t=1: V=106*pi', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const { shape, faces } = makeCylinderWithFaces(occ, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const canon = canonicalFaces(occ, scope, shape)
      const face_uuids = canon.map((_, i) => `c${i}`)
      const topIdx = canon.findIndex((f) => (f as unknown as { IsSame(o: unknown): boolean }).IsSame(faces.top))
      const body: Body = {
        id: 'body_c', created_by: 'cy', modified_by: [], shape: table.register(shape, 'cy'),
        sketch_id: 'sk', brep_diff: null, profile_queries: [], face_uuids,
      }
      const bodyStore = { body_c: body }
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [faceQuery(face_uuids[topIdx])], thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('ok')
      expect(volumeOf(occ, scope, shelledShape(scope, table, body))).toBeCloseTo(106 * Math.PI, 4)
    } finally {
      scope.dispose()
    }
  })

  it('a thickness past the local radius errors and leaves the body unchanged', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const shapeBefore = body.shape
      const namesBefore = JSON.stringify(body.face_uuids)
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      let threw: unknown = null
      try {
        solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 6 } }, new Repository(), bodyStore)
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      expect((threw as Error).message).toContain('shell')
      expect(body.modified_by).toEqual([])
      expect(body.brep_diff).toBeNull()
      expect(body.shape).toBe(shapeBefore)
      expect(JSON.stringify(body.face_uuids)).toBe(namesBefore)
    } finally {
      scope.dispose()
    }
  })

  // The robustness fuzz seed 398 drew this: walls exactly half the width meet
  // in the middle, and OCC hands back a solid that passes BRepCheck yet holds
  // no material. It must refuse like the past-the-radius case above.
  it('a thickness of exactly half the width errors instead of building an empty solid', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const shapeBefore = body.shape
      const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      expect(() => solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [q], thickness: 5 } }, new Repository(), bodyStore))
        .toThrow(/shell/)
      expect(body.shape).toBe(shapeBefore)
      expect(body.modified_by).toEqual([])
    } finally {
      scope.dispose()
    }
  })

  it('names the offset and rim faces by construction, and they survive a 10 -> 14 edit', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const resolveOffsetAndRim = (size: number): { offset: string; rim: string } => {
        const bodyStore = boxBody(scope, table, size)
        const body = bodyStore.body_b
        const topUuid = body.face_uuids![topFaceIndex(scope, table, body)]!
        // The offset face for the bottom (z-min) and the rim of the opened top.
        const bottomUuid = body.face_uuids![bottomFaceIndex(scope, table, body)]!
        const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [faceQuery(topUuid)], thickness: 1 } }, new Repository(), bodyStore)
        expect(res.status).toBe('ok')
        // Every result face carries a UUID.
        expect(body.face_uuids!.every((u) => u !== null)).toBe(true)
        const expected = {
          offset: mintFaceUuid(shellFacePath('sh1', 'offset', bottomUuid)),
          rim: mintFaceUuid(shellFacePath('sh1', 'rim', topUuid)),
        }
        expect(body.face_uuids).toContain(expected.offset)
        expect(body.face_uuids).toContain(expected.rim)
        return expected
      }
      const ten = resolveOffsetAndRim(10)
      expect(ten.offset).toBe(mintFaceUuid(shellFacePath('sh1', 'offset', 'f4')))
      // The names are stable by construction: the same source-face UUIDs mint
      // the same offset/rim UUIDs on a differently-sized box.
      const fourteen = resolveOffsetAndRim(14)
      expect(fourteen.offset).toBe(ten.offset)
      expect(fourteen.rim).toBe(ten.rim)
    } finally {
      scope.dispose()
    }
  })

  it('a stale face pick yields partial + unresolved_faces, and the shell still runs', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const good = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
      const stale = faceQuery('f_dead')  // a face UUID that no current face holds
      const res = solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [good, stale], thickness: 1 } }, new Repository(), bodyStore)
      expect(res.status).toBe('partial')
      expect(res.unresolved_faces).toEqual([stale])
      expect(volumeOf(occ, scope, shelledShape(scope, table, body))).toBeCloseTo(424, 4)
    } finally {
      scope.dispose()
    }
  })

  it('faces naming two bodies throw, naming both', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const a = boxBody(scope, table)
      const bBody = makeBox(occ, scope, 10, 10, 10)
      const bFaces = canonicalFaces(occ, scope, bBody)
      const bUuids = bFaces.map((_, i) => `g${i}`)
      a.body_c = {
        id: 'body_c', created_by: 'ex2', modified_by: [], shape: table.register(bBody, 'ex2'),
        sketch_id: 'sk2', brep_diff: null, profile_queries: [], face_uuids: bUuids,
      }
      const qa = faceQuery(a.body_b.face_uuids![0]!)
      const qb = faceQuery(bUuids[0])
      let threw: unknown = null
      try {
        solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [qa, qb], thickness: 1 } }, new Repository(), a)
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      const msg = (threw as Error).message
      expect(msg).toContain('body_b')
      expect(msg).toContain('body_c')
    } finally {
      scope.dispose()
    }
  })

  it('an inner edge still resolves through fillet after a 10 -> 14 edit', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // Shell a 10-box, pick an INNER edge (one bounding the offset cavity
      // floor) by construction, and return its query and the fillet result.
      const filletInnerEdge = (size: number, storedQuery: string | null): { query: string; status: string } => {
        const bodyStore = boxBody(scope, table, size)
        const body = bodyStore.body_b
        const topUuid = body.face_uuids![topFaceIndex(scope, table, body)]!
        const bottomUuid = body.face_uuids![bottomFaceIndex(scope, table, body)]!
        solveShell(occ, scope, table, { id: 'sh1', shell: { faces: [faceQuery(topUuid)], thickness: 1 } }, new Repository(), bodyStore)
        const offsetFloor = mintFaceUuid(shellFacePath('sh1', 'offset', bottomUuid))
        const outerEdges = canonicalEdges(occ, scope, table.get<OccShape>(body.shape!))
        const innerEdge = exploreEdges(occ, scope, buildFaceIndex(occ, scope, table, body).byUuid.get(offsetFloor)!)
        const at = outerEdges.findIndex((ce) => innerEdge.some((e) => (e as OccSubShape).IsSame(ce as OccSubShape)))
        expect(at, 'the offset floor must bound a result edge').toBeGreaterThanOrEqual(0)
        const uuid = body.edge_uuids![at]!
        expect(uuid).not.toBeNull()
        const query = storedQuery ?? makeAncestryQuery([constructionUuidToken(uuid)], 'edge')
        const res = solveFillet(occ, scope, table, { id: 'fi1', fillet: { edges: [query], radius: 0.2 } }, new Repository(), bodyStore)
        return { query, status: res.status }
      }
      const ten = filletInnerEdge(10, null)
      expect(ten.status).toBe('ok')
      // Rebuild at 14 with the pick stored at 10: the construction UUID is
      // stable, so the same inner edge resolves and fillets.
      const fourteen = filletInnerEdge(14, ten.query)
      expect(fourteen.query).toBe(ten.query)
      expect(fourteen.status).toBe('ok')
    } finally {
      scope.dispose()
    }
  })
})
