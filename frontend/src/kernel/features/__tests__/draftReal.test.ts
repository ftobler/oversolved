// @vitest-environment node
//
// Gated real-OCC end-to-end test for the draft LEAF (features/draft.ts): the
// neutral-plane and pull-direction resolution through the repository, the OCC
// DraftAngle call, construction naming of the tilted faces, the body-store
// update and the refusal paths (unresolved picks, a build-level refusal). The
// OCCT call/history facts themselves are pinned by
// occ/__tests__/draftAngleProbeReal.test.ts.
//
// Faces are addressed by their construction-UUID query (the wire form the
// viewport mints), and the neutral plane is a registered flatface entry, so the
// test does not depend on face enumeration order beyond the body it builds itself.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, faceCentroid } from '../../occ/primitives'
import { volumeOf } from '../../occ/volume'
import { canonicalEdges, canonicalFaces, namesFromArray, namesToArray } from '../../occ/bodyNames'
import { deriveEdgeNames } from '../../occ/constructionLineage'
import { ref, Repository, makeAncestryQuery, constructionUuidToken } from '../../query'
import { mintFaceUuid, draftFacePath } from '../../constructionName'
import { solveDraft } from '../draft'
import type { DraftFeature } from '@/types/cad'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

const FACE_TYPE = 'flatface'

/** A face pick query for the face that carries `uuid`. */
const faceQuery = (uuid: string): string => makeAncestryQuery([constructionUuidToken(uuid)], FACE_TYPE)

/** The neutral-plane entry a solved planar face leaves in the repo. */
const NEUTRAL_ORIGIN = [5, 5, 0]
const NEUTRAL_NORMAL = [0, 0, -1]
const NEUTRAL_IDS = ['@ex1/f_bottom', '@ex1']
const NEUTRAL_QUERY = makeAncestryQuery(NEUTRAL_IDS, FACE_TYPE)

function repoWithNeutral(): Repository {
  const repo = new Repository()
  repo.registerAncestor(NEUTRAL_IDS, { type: 'flatface', origin: NEUTRAL_ORIGIN, normal: NEUTRAL_NORMAL })
  return repo
}

const draftFeature = (draft: Partial<DraftFeature['draft']>): DraftFeature => ({
  id: 'dr1', kind: 'draft', label: 'Draft',
  draft: { faces: [], angle: 10, neutral: NEUTRAL_QUERY, ...draft },
})

describe.skipIf(!oc)('solveDraft leaf (real OCC)', () => {
  let occ: OccModule
  if (oc) occ = oc

  // A named 10-millimetre box body: faces `f0..f5` in canonical order.
  function boxBody(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const box = makeBox(occ, scope, 10, 10, 10)
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

  /** The body's face whose centroid coordinate on `axis` is greatest/least. */
  function sideFace(scope: DisposeScope, table: HandleTable, body: Body, axis: 0 | 1 | 2, which: 'min' | 'max'): string {
    const faces = canonicalFaces(occ, scope, table.get<OccShape>(body.shape!)) as OccShape[]
    let best = 0
    faces.forEach((f, i) => {
      const c = faceCentroid(occ, scope, f)[axis]
      const b = faceCentroid(occ, scope, faces[best])[axis]
      if (which === 'max' ? c > b : c < b) best = i
    })
    return body.face_uuids![best]!
  }

  it('drafts both x-facing sides by the analytic volume', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const left = sideFace(scope, table, body, 0, 'min')
      const right = sideFace(scope, table, body, 0, 'max')
      const res = solveDraft(
        occ, scope, table,
        draftFeature({ faces: [faceQuery(left), faceQuery(right)] }),
        repoWithNeutral(), bodyStore,
      )
      expect(res.status).toBe('ok')
      expect(res.body_ids).toEqual(['body_b'])
      // 1000 - 2 * (10 * tan(10deg)) * 10 / 2 = 823.673.
      expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeCloseTo(823.673019291535, 6)
      expect(canonicalFaces(occ, scope, table.get<OccShape>(body.shape!))).toHaveLength(6)
      expect(body.modified_by).toEqual(['dr1'])
      expect(body.brep_diff?.new_faces.length).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('names the tilted faces after their source picks and keeps the untouched ones', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const left = sideFace(scope, table, body, 0, 'min')
      const right = sideFace(scope, table, body, 0, 'max')
      const res = solveDraft(
        occ, scope, table,
        draftFeature({ faces: [faceQuery(left), faceQuery(right)] }),
        repoWithNeutral(), bodyStore,
      )
      expect(res.status).toBe('ok')
      const uuids = body.face_uuids ?? []
      // Every result face keeps a UUID, and the two tilted faces are named after
      // the faces they were picked as.
      expect(uuids.every((u) => typeof u === 'string' && u.length > 0)).toBe(true)
      expect(uuids).toContain(mintFaceUuid(draftFacePath('dr1', left)))
      expect(uuids).toContain(mintFaceUuid(draftFacePath('dr1', right)))
      // The bottom and top faces are untouched by the draft and survive by
      // identity: f4 and f5 in the canonical order of this makeBox body.
      expect(uuids).toContain('f4')
      expect(uuids).toContain('f5')
    } finally {
      scope.dispose()
    }
  })

  it('resolves the pull direction from a picked edge, flipping the pick into the body', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const left = sideFace(scope, table, body, 0, 'min')
      const right = sideFace(scope, table, body, 0, 'max')
      const repo = repoWithNeutral()
      // The pick points DOWN (out of the body through the neutral plane); the
      // leaf must orient it into the body so the positive angle still recedes.
      const dirIds = ['@ex1/e_bottom', '@ex1']
      repo.registerAncestor(dirIds, { start: [5, 5, 0], end: [5, 5, -1] })
      const res = solveDraft(
        occ, scope, table,
        draftFeature({ faces: [faceQuery(left), faceQuery(right)], direction: makeAncestryQuery(dirIds, 'edge') }),
        repo, bodyStore,
      )
      expect(res.status).toBe('ok')
      expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeCloseTo(823.673019291535, 6)
    } finally {
      scope.dispose()
    }
  })

  it('a stale pick is unresolved and the other picks still draft', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const left = sideFace(scope, table, body, 0, 'min')
      const stale = faceQuery('f_dead')
      const res = solveDraft(
        occ, scope, table,
        draftFeature({ faces: [faceQuery(left), stale] }),
        repoWithNeutral(), bodyStore,
      )
      expect(res.status).toBe('partial')
      expect(res.unresolved_faces).toEqual([stale])
      // The one resolved pick still drafted: 1000 - 88.1635 = 911.837.
      expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeCloseTo(911.8365096457674, 6)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a draft whose neutral plane does not resolve, naming the pick', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const left = sideFace(scope, table, body, 0, 'min')
      expect(() =>
        solveDraft(
          occ, scope, table,
          draftFeature({ faces: [faceQuery(left)], neutral: makeAncestryQuery(['@ex1/f_dead'], FACE_TYPE) }),
          repoWithNeutral(), bodyStore,
        ),
      ).toThrow(/neutral plane.*did not resolve/)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a no-op angle and an empty face list by name', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const left = sideFace(scope, table, body, 0, 'min')
      expect(() =>
        solveDraft(occ, scope, table, draftFeature({ faces: [faceQuery(left)], angle: 0 }), repoWithNeutral(), bodyStore),
      ).toThrow(/angle must be non-zero/)
      expect(() =>
        solveDraft(occ, scope, table, draftFeature({ faces: [] }), repoWithNeutral(), bodyStore),
      ).toThrow(/at least one face/)
    } finally {
      scope.dispose()
    }
  })

  it('a face the neutral plane does not touch fails the whole build with a message', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const top = sideFace(scope, table, body, 2, 'max')
      let threw: unknown = null
      try {
        solveDraft(
          occ, scope, table,
          draftFeature({ faces: [faceQuery(top)] }),
          repoWithNeutral(), bodyStore,
        )
      } catch (e) {
        threw = e
      }
      expect(threw).not.toBeNull()
      expect((threw as Error).message).toMatch(/^draft: /)
      expect(body.modified_by).toEqual([])
      expect(body.brep_diff).toBeNull()
    } finally {
      scope.dispose()
    }
  })

  it('hinges on the neutral plane: the drafted wall keeps its base and recedes at the top', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const bodyStore = boxBody(scope, table)
      const body = bodyStore.body_b
      const left = sideFace(scope, table, body, 0, 'min')
      const res = solveDraft(
        occ, scope, table,
        draftFeature({ faces: [faceQuery(left)] }),
        repoWithNeutral(), bodyStore,
      )
      expect(res.status).toBe('ok')
      const shape = table.get<OccShape>(body.shape!)
      const box = scope.track(new occ.Bnd_Box_1())
      occ.BRepBndLib.Add(shape, box, false)
      // The base sits on the neutral plane, so the outer extent is unchanged;
      // only the volume moved (the top receded by 10*tan(10deg)).
      expect([box.GetXmin(), box.GetYmin(), box.GetZmin(), box.GetXmax(), box.GetYmax(), box.GetZmax()].map((n) => Math.round(n)))
        .toEqual([0, 0, 0, 10, 10, 10])
    } finally {
      scope.dispose()
    }
  })
})
