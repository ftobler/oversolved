// @vitest-environment node
//
// Construction names for the arc join. OCC builds the rounded corners from the
// input's EDGES (a quarter cylinder, role `blend`) and VERTICES (a sphere
// patch, role `corner`); the probe in occ/__tests__/thickSolidProbeReal.test.ts
// pins that narration. Here the leaf must turn it into stable names:
// `<shellId>|shell|blend|<sourceEdgeUuid>` and
// `<shellId>|shell|corner|<sorted incident edge uuids>`. The second test stores
// a pick on a blend edge, thickens the wall, and resolves the same pick again.
//
// OCC refuses to fillet the blend edge itself: the quarter cylinder meets the
// flat wall tangentially, so BRepFilletAPI_MakeFillet continues over the G1
// joint and the pick leaves the chain incomplete (build_failed). The stability
// check therefore stops at resolution, which is what the construction name
// guarantees; a later fillet pick on a blend-derived edge has the same UUID.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, faceCentroid } from '../../occ/primitives'
import { canonicalEdges, canonicalFaces, canonicalVertices, namesFromArray, namesToArray } from '../../occ/bodyNames'
import { deriveEdgeNames } from '../../occ/constructionLineage'
import { exploreEdges } from '../../occ/edgeModifier'
import { buildFaceIndex } from '../shared/faceResolution'
import { makeEdgeIndexCache, resolveEdgesByQuery } from '../filletChamfer'
import { makeAncestryQuery, constructionUuidToken, ref, Repository } from '../../query'
import { mintFaceUuid, shellFacePath } from '../../constructionName'
import { solveShell } from '../shell'
import type { Body } from '../../types3d'
import type { OccModule, OccShape, OccSubShape } from '../../occ/occTypes'

const oc = await loadOcc()

const faceQuery = (uuid: string): string => makeAncestryQuery([constructionUuidToken(uuid)], 'flatface')
const edgeQuery = (uuid: string): string => makeAncestryQuery([constructionUuidToken(uuid)], 'edge')

describe.skipIf(!oc)('arc join naming (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  function namedBody(scope: DisposeScope, table: HandleTable): Body {
    const box = makeBox(occ, scope, 2, 2, 2)
    const faces = canonicalFaces(occ, scope, box)
    const face_uuids = faces.map((_, i) => `f${i}`)
    const faceAncestry = Object.fromEntries(face_uuids.map((u) => [u, [ref('ex1'), ref('body_b')]]))
    const { edgeNames, edgeAncestry } = deriveEdgeNames(occ, scope, box, namesFromArray(faces, face_uuids), faceAncestry)
    const edge_uuids = namesToArray(canonicalEdges(occ, scope, box), edgeNames)
    return {
      id: 'body_b', created_by: 'ex1', modified_by: [],
      shape: table.register(box, 'ex1'), sketch_id: 'sk', brep_diff: null,
      profile_queries: [], face_uuids, edge_uuids, face_ancestry: faceAncestry, edge_ancestry: edgeAncestry,
    }
  }

  function topFaceIndex(scope: DisposeScope, table: HandleTable, body: Body): number {
    const faces = canonicalFaces(occ, scope, table.get<OccShape>(body.shape!))
    let best = 0
    faces.forEach((f, i) => {
      if (faceCentroid(occ, scope, f as never)[2] > faceCentroid(occ, scope, faces[best] as never)[2]) best = i
    })
    return best
  }

  function arcShell(scope: DisposeScope, table: HandleTable, thickness: number): Body {
    const body = namedBody(scope, table)
    const q = faceQuery(body.face_uuids![topFaceIndex(scope, table, body)]!)
    const res = solveShell(occ, scope, table, {
      id: 'sh1', shell: { faces: [q], thickness, direction: 'outward', join: 'arc' },
    }, new Repository(), { body_b: body })
    expect(res.status).toBe('ok')
    return body
  }

  // The uuids a corner face is keyed on: sorted incident edge uuids per vertex.
  function cornerKeys(scope: DisposeScope, shape: OccShape, edgeUuids: (string | null)[]): string[] {
    const edges = canonicalEdges(occ, scope, shape) as OccShape[]
    return canonicalVertices(occ, scope, shape).map((vertex) => {
      const incident = edges
        .map((edge, at) => ({ edge, uuid: edgeUuids[at] }))
        .filter(({ edge }) => (canonicalVertices(occ, scope, edge) as OccSubShape[])
          .some((v) => v.IsSame(vertex as OccSubShape)))
        .map(({ uuid }) => uuid)
        .filter((u): u is string => typeof u === 'string')
        .sort()
      return incident.join('|')
    }).filter((key) => key !== '')
  }

  it('names every Ex017 arc face, including 8 blends and 4 corners', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const original = namedBody(scope, table)
      const shape = table.get<OccShape>(original.shape!)
      const topUuid = original.face_uuids![topFaceIndex(scope, table, original)]!
      const keptUuids = original.face_uuids!.filter((u): u is string => u !== null && u !== topUuid)
      const edgeUuids = original.edge_uuids!.filter((u): u is string => typeof u === 'string')
      const corners = cornerKeys(scope, shape, original.edge_uuids!)

      const body = arcShell(scope, table, 0.05)
      expect(body.face_uuids).toHaveLength(23)
      expect(body.face_uuids!.every((u) => typeof u === 'string' && u !== '')).toBe(true)

      const has = (uuid: string): boolean => body.face_uuids!.includes(uuid)
      const expected = new Set<string>()
      for (const uuid of keptUuids) {
        expect(has(uuid), `kept ${uuid}`).toBe(true)
        expected.add(uuid)
        const offset = mintFaceUuid(shellFacePath('sh1', 'offset', uuid))
        expect(has(offset), `offset ${uuid}`).toBe(true)
        expected.add(offset)
      }
      const rim = mintFaceUuid(shellFacePath('sh1', 'rim', topUuid))
      expect(has(rim)).toBe(true)
      expected.add(rim)
      // 4 vertical edges and 4 bottom edges round; the 4 top rim edges do not.
      // Only the 4 bottom vertices need a sphere patch (the opening's top
      // corners are boundary curves, not corner faces).
      expect(edgeUuids).toHaveLength(12)
      expect(corners).toHaveLength(8)
      const blends = edgeUuids
        .map((uuid) => mintFaceUuid(shellFacePath('sh1', 'blend', uuid)))
        .filter((uuid) => has(uuid))
      const cornerFaces = corners
        .map((key) => mintFaceUuid(shellFacePath('sh1', 'corner', key)))
        .filter((uuid) => has(uuid))
      expect(blends).toHaveLength(8)
      expect(cornerFaces).toHaveLength(4)
      for (const uuid of [...blends, ...cornerFaces]) expected.add(uuid)
      // Every face is accounted for by exactly the construction roles.
      expect(expected.size).toBe(23)
      for (const uuid of body.face_uuids!) expect(expected.has(uuid!), `unexpected ${uuid}`).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('names the closed-hollow arc faces through the offset maker', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const body = namedBody(scope, table)
      const shape = table.get<OccShape>(body.shape!)
      const edgeUuids = body.edge_uuids!.filter((u): u is string => typeof u === 'string')
      const corners = cornerKeys(scope, shape, body.edge_uuids!)
      const res = solveShell(occ, scope, table, {
        id: 'sh1',
        shell: { faces: [], thickness: 0.05, direction: 'outward', source_body: '@body_b', join: 'arc' },
      }, new Repository(), { body_b: body })
      expect(res.status).toBe('ok')
      expect(body.face_uuids!.every((u) => typeof u === 'string' && u !== '')).toBe(true)
      expect(body.face_uuids!.some((u) =>
        typeof u === 'string' && edgeUuids.some((e) => u === mintFaceUuid(shellFacePath('sh1', 'blend', e))))).toBe(true)
      expect(body.face_uuids!.some((u) =>
        typeof u === 'string' && corners.some((k) => u === mintFaceUuid(shellFacePath('sh1', 'corner', k))))).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('a pick on a blend edge resolves after the wall thickens', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const first = namedBody(scope, table)
      const blendUuids = new Set(first.edge_uuids!
        .filter((u): u is string => typeof u === 'string')
        .map((u) => mintFaceUuid(shellFacePath('sh1', 'blend', u))))
      const firstTop = first.face_uuids![topFaceIndex(scope, table, first)]!
      const firstRes = solveShell(occ, scope, table, {
        id: 'sh1', shell: { faces: [faceQuery(firstTop)], thickness: 0.05, direction: 'outward', join: 'arc' },
      }, new Repository(), { body_b: first })
      expect(firstRes.status).toBe('ok')

      // Pick an edge of a blend face by construction, then rebuild at 0.06
      // with the stored query. The edge UUID must survive the thickness edit.
      const blendUuid = first.face_uuids!.find((u) => typeof u === 'string' && blendUuids.has(u))!
      const blendFace = buildFaceIndex(occ, scope, table, first).byUuid.get(blendUuid)
      expect(blendFace).toBeDefined()
      const firstEdges = canonicalEdges(occ, scope, table.get<OccShape>(first.shape!)) as OccShape[]
      const edgeUuid = exploreEdges(occ, scope, blendFace!)
        .map((edge) => {
          const at = firstEdges.findIndex((ce) => (ce as OccSubShape).IsSame(edge as OccSubShape))
          return at >= 0 ? first.edge_uuids![at] : null
        })
        .find((u): u is string => typeof u === 'string')
      expect(edgeUuid).toBeDefined()

      const second = arcShell(scope, table, 0.06)
      expect(second.edge_uuids).toContain(edgeUuid)
      const indexFor = makeEdgeIndexCache(occ, scope, table)
      const resolved = resolveEdgesByQuery(
        occ, scope, table, second, indexFor(second), [edgeQuery(edgeUuid!)],
      )
      expect(resolved.get(edgeQuery(edgeUuid!))).toHaveLength(1)
    } finally {
      scope.dispose()
    }
  })
})
