// @vitest-environment node
//
// Regression for the shell opening pick: one profile entity can generate more
// than one lateral face (here the circle at x = 30 is split into arcs by the
// other loops, and the prism gives each arc its own half-cylinder). Both halves
// used to be minted the same side-face UUID, so the face index collapsed them
// into one entry and a pick carrying the sibling's classifier resolved to
// whichever face happened to register last.
//
// The document is the bug report's: a ring at the origin plus a circle at
// x = 30, extruded into one body. The two picks under test are the sibling
// half-cylinders of the x = 30 circle.
//
// Skips when OCC.js or the Rust sketch solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { canonicalFaces } from '../../occ/bodyNames'
import { faceCentroid } from '../../occ/primitives'
import { mintFaceUuid, sideFacePath } from '../../constructionName'
import { parseAncestry, makeAncestryQuery, constructionUuidToken } from '../../query'
import {
  buildFaceIndex,
  resolveFacesByQuery,
  queryFaceUuid,
} from '../shared/faceResolution'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { Body } from '../../types3d'
import type { BuildResponse } from '../../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

const SKETCH_ID = 'ej5yKuzkrjyx1bIum42EJLki'
const EXTRUDE_ID = 'UU4SAjHG0AQZAsU8C2j5JKjo'
const BODY_ID = 'body_' + EXTRUDE_ID
const CIRCLE = '0IPnfibogdJZCeul'
// The pick stored in the bug report's document: the pre-split proto uuid and
// the `cls_yn` classifier of the sibling the shell is meant to open.
const LEGACY_YN_QUERY =
  '?15,19,1e,2a,7,7;@u|u_d81d3a83278682b2@UU4SAjHG0AQZAsU8C2j5JKjo@body_UU4SAjHG0AQZAsU8C2j5JKjo' +
  '@ej5yKuzkrjyx1bIum42EJLki/0IPnfibogdJZCeul@cls_xp@cls_yn:cylinderface'

const SKETCH = {
  id: SKETCH_ID,
  kind: 'sketch',
  label: 'sketch 1',
  plane: '@builtin_plane_front',
  initial: {
    '43NO99KuPeLF1spx': [0, 0, 25],
    _yxEcYDVIUOLVgBH: [0, 0, 15],
    '0IPnfibogdJZCeul': [30, 0, 25],
  },
  entities: [
    { id: '43NO99KuPeLF1spx', kind: 'circle' },
    { id: '_yxEcYDVIUOLVgBH', kind: 'circle' },
    { id: '0IPnfibogdJZCeul', kind: 'circle' },
  ],
  constraints: [
    { id: 'c_coincident_RF7V5ahW', kind: 'coincident', a: '$43NO99KuPeLF1spxcenter', b: '@builtin_origin' },
    { id: 'c_coincident_Nweg2Heu', kind: 'coincident', a: '$_yxEcYDVIUOLVgBHcenter', b: '$43NO99KuPeLF1spxcenter' },
    { id: 'c_radius_difference_1eN-DrCz', kind: 'radius_difference', a: '$_yxEcYDVIUOLVgBH', b: '$43NO99KuPeLF1spx', value: 10, pos: [-23.039145, 43.560241] },
    { id: 'c_diameter_DbYzTFco', kind: 'diameter', target: '$_yxEcYDVIUOLVgBH', value: 30, pos: [38.985063, 21.546119] },
    { id: 'c_equal_length_NzFw9tv_', kind: 'equal_length', a: '$0IPnfibogdJZCeul', b: '$43NO99KuPeLF1spx' },
    { id: 'c_point_distance_x_xVCq_ty_', kind: 'point_distance_x', a: '$0IPnfibogdJZCeulcenter', b: '$43NO99KuPeLF1spxcenter', value: 30, pos: [-0.200235, -37.805783], sign: -1 },
    { id: 'c_horizontal_9masKtYp', kind: 'horizontal', a: '$0IPnfibogdJZCeulcenter', b: '$43NO99KuPeLF1spxcenter' },
  ],
  auto_hidden: true,
  visible: false,
}

const EXTRUDE = {
  id: EXTRUDE_ID,
  kind: 'extrude',
  label: 'extrude 1',
  extrude: {
    sketch: ['?2a,2a,2a,2a,9,19;@ej5yKuzkrjyx1bIum42EJLki/0IPnfibogdJZCeul@ej5yKuzkrjyx1bIum42EJLki/0IPnfibogdJZCeul@ej5yKuzkrjyx1bIum42EJLki/43NO99KuPeLF1spx@ej5yKuzkrjyx1bIum42EJLki/_yxEcYDVIUOLVgBHsurface:2@ej5yKuzkrjyx1bIum42EJLki:flatface'],
    distance: 10,
    direction: 'normal',
  },
}

const BASE_FEATURES = [SKETCH, EXTRUDE]

interface FaceDatum {
  centroid: number[]
  surface_type: string
}

/** The two sibling half-cylinders of the x = 30 circle, by query and centroid. */
function siblingFaces(r: BuildResponse): Array<{ query: string; y: number }> {
  const mesh = ((r.bodies as Record<string, { mesh?: { face_data?: FaceDatum[]; face_queries?: string[] } }>)[BODY_ID]?.mesh) ?? {}
  const data = mesh.face_data ?? []
  const queries = mesh.face_queries ?? []
  const out: Array<{ query: string; y: number }> = []
  data.forEach((fd, i) => {
    const q = queries[i] ?? ''
    if (fd.surface_type !== 'cylinderface') return
    if (!q.includes(`/${CIRCLE}`)) return
    out.push({ query: q, y: fd.centroid[1] })
  })
  return out
}

function queryUuid(q: string): string | null {
  return queryFaceUuid(q)
}

/** Rewrite a query's construction UUID, keeping its lineage and classifiers. */
function withUuid(q: string, uuid: string): string {
  const [ids, type, classifier] = parseAncestry(q)
  const tokens = ids.map((id) => (isConstructionUuidToken(id) ? constructionUuidToken(uuid) : id))
  return makeAncestryQuery(tokens, type, classifier)
}

function isConstructionUuidToken(id: string): boolean {
  return id.startsWith('@u|')
}

describe.skipIf(!oc || !solveBytes)('shell sibling opening pick (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function bodyOf(r: BuildResponse, featureId: string): Body {
    return r._build_state!.checkpoints[featureId].body_store_snapshot[BODY_ID]
  }

  function shapeOf(r: BuildResponse, featureId: string): OccShape {
    return h.table.get<OccShape>(bodyOf(r, featureId).shape!)
  }

  it('one profile entity split into two side faces gets two truthful, resolvable UUIDs', () => {
    const r = h.run({ features: BASE_FEATURES })
    const siblings = siblingFaces(r)
    expect(siblings).toHaveLength(2)
    const yp = siblings.find((s) => s.y > 0)!
    const yn = siblings.find((s) => s.y < 0)!
    expect(yp).toBeDefined()
    expect(yn).toBeDefined()

    // Truthful identity: one face, one UUID. The shared side-face UUID used to
    // leave the UUID tier with a single entry (last wins).
    expect(queryUuid(yp.query)).not.toBe(queryUuid(yn.query))

    const scope = new DisposeScope()
    try {
      const body = bodyOf(r, EXTRUDE_ID)
      const index = buildFaceIndex(occ, scope, h.table, body)
      expect(index.byUuid.get(queryUuid(yp.query)!)).toBeDefined()
      expect(index.byUuid.get(queryUuid(yn.query)!)).toBeDefined()
      expect(index.byUuid.get(queryUuid(yp.query)!)).not.toBe(index.byUuid.get(queryUuid(yn.query)!))

      const resolved = resolveFacesByQuery(
        occ, scope, h.table, body, index, [yp.query, yn.query], { [BODY_ID]: body },
      )
      const faceYp = resolved.get(yp.query)!
      const faceYn = resolved.get(yn.query)!
      expect(faceYp).not.toBeNull()
      expect(faceYn).not.toBeNull()
      // Each query must land on its own sibling, not on the other one.
      expect(faceCentroid(occ, scope, faceYp as OccShape)[1]).toBeGreaterThan(0)
      expect(faceCentroid(occ, scope, faceYn as OccShape)[1]).toBeLessThan(0)

      // A pick stored before this fix names the old shared UUID. That uuid is
      // dead now, so the resolution must fall back to lineage plus classifiers
      // and land on the sibling the query itself describes.
      const legacy = (q: string): string => withUuid(q, 'u_d81d3a83278682b2')
      const legacyResolved = resolveFacesByQuery(
        occ, scope, h.table, body, index, [legacy(yp.query), legacy(yn.query)], { [BODY_ID]: body },
      )
      const legacyYp = legacyResolved.get(legacy(yp.query))!
      const legacyYn = legacyResolved.get(legacy(yn.query))!
      expect(legacyYp).not.toBeNull()
      expect(legacyYn).not.toBeNull()
      expect(faceCentroid(occ, scope, legacyYp as OccShape)[1]).toBeGreaterThan(0)
      expect(faceCentroid(occ, scope, legacyYn as OccShape)[1]).toBeLessThan(0)

      // The migration is only for a dead uuid the query's own lineage
      // recomputes. A live foreign uuid must not be retried: with the exact
      // tier bypassed, the stable tier still sees it live and must miss when
      // the named face's classifiers contradict the query.
      const probe = { byUuid: new Map<string, OccShape>(), ancestryRepo: index.ancestryRepo }
      const liveForeign = withUuid(legacy(yn.query), queryUuid(yp.query)!)
      const probeResolved = resolveFacesByQuery(
        occ, scope, h.table, body, probe, [liveForeign], { [BODY_ID]: body },
      )
      expect(probeResolved.get(liveForeign)).toBeNull()

      // A dead uuid that no (feature, sketch/entity) pair reproduces is not a
      // pre-split prism side face either, so it misses rather than migrating.
      const unknownDead = withUuid(legacy(yn.query), 'u_0123456789abcdef')
      const unknownResolved = resolveFacesByQuery(
        occ, scope, h.table, body, index, [unknownDead], { [BODY_ID]: body },
      )
      expect(unknownResolved.get(unknownDead)).toBeNull()

      // A profile entity that still reaches exactly one face keeps the old
      // per-entity UUID, so every existing document query for it stays live.
      const mesh = (r.bodies as Record<string, { mesh?: { face_data?: FaceDatum[]; face_queries?: string[] } }>)[BODY_ID]!.mesh!
      const cylinderQuery = (entity: string): string => {
        const i = (mesh.face_data ?? []).findIndex((fd, at) =>
          fd.surface_type === 'cylinderface' && (mesh.face_queries?.[at] ?? '').includes(`/${entity}`))
        return mesh.face_queries![i]!
      }
      expect(queryUuid(cylinderQuery('43NO99KuPeLF1spx')))
        .toBe(mintFaceUuid(sideFacePath(EXTRUDE_ID, `${SKETCH_ID}/43NO99KuPeLF1spx`)))
      expect(queryUuid(cylinderQuery('_yxEcYDVIUOLVgBH')))
        .toBe(mintFaceUuid(sideFacePath(EXTRUDE_ID, `${SKETCH_ID}/_yxEcYDVIUOLVgBH`)))
    } finally {
      scope.dispose()
    }
  })

  it('shell removes the picked sibling face, not the other one', () => {
    const base = h.run({ features: BASE_FEATURES })
    const siblings = siblingFaces(base)
    const yp = siblings.find((s) => s.y > 0)!
    const yn = siblings.find((s) => s.y < 0)!

    for (const [picked, kept] of [[yp, yn], [yn, yp]] as const) {
      const r = h.run({
        features: [
          ...BASE_FEATURES,
          { id: 'TE3etvAaKLdhcbtaACRcuK1q', kind: 'shell', shell: { faces: [picked.query], thickness: 1, direction: 'inward' } },
        ],
      })
      const shellResult = r.result.TE3etvAaKLdhcbtaACRcuK1q as { status: string }
      expect(shellResult.status).toBe('ok')
      const body = bodyOf(r, 'TE3etvAaKLdhcbtaACRcuK1q')
      const uuids = body.face_uuids ?? []
      // The opening consumes the picked face's UUID; the sibling survives.
      expect(uuids).toContain(queryUuid(kept.query))
      expect(uuids).not.toContain(queryUuid(picked.query))
      // The surviving outer half-cylinder is still on the kept side.
      const scope = new DisposeScope()
      try {
        const shape = shapeOf(r, 'TE3etvAaKLdhcbtaACRcuK1q')
        const yOfKept = canonicalFaces(occ, scope, shape)
          .map((f) => faceCentroid(occ, scope, f as OccShape)[1])
        expect(yOfKept.some((y) => Math.sign(y) === Math.sign(kept.y))).toBe(true)
      } finally {
        scope.dispose()
      }
    }
  })

  it('split side-face UUIDs are deterministic across rebuilds', () => {
    const pair = () => {
      const siblings = siblingFaces(h.run({ features: BASE_FEATURES }))
      return {
        yp: queryUuid(siblings.find((s) => s.y > 0)!.query),
        yn: queryUuid(siblings.find((s) => s.y < 0)!.query),
      }
    }
    expect(pair()).toEqual(pair())
  })

  it('migrates the literal stored pick to the cls_yn sibling', () => {
    const base = h.run({ features: BASE_FEATURES })
    const siblings = siblingFaces(base)
    const yp = siblings.find((s) => s.y > 0)!
    const yn = siblings.find((s) => s.y < 0)!
    const r = h.run({
      features: [
        ...BASE_FEATURES,
        {
          id: 'TE3etvAaKLdhcbtaACRcuK1q',
          kind: 'shell',
          shell: { faces: [LEGACY_YN_QUERY], thickness: 1, direction: 'inward' },
        },
      ],
    })
    expect((r.result.TE3etvAaKLdhcbtaACRcuK1q as { status: string }).status).toBe('ok')
    const uuids = bodyOf(r, 'TE3etvAaKLdhcbtaACRcuK1q').face_uuids ?? []
    // The stored query names the y-negative sibling, so that is the opening;
    // the y-positive sibling survives.
    expect(uuids).not.toContain(queryUuid(yn.query))
    expect(uuids).toContain(queryUuid(yp.query))
  })
})
