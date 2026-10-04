// @vitest-environment node
//
// Gated real-OCC gate for the body-face path of resolveFaceProfile
// (features/faceProfile.ts): `@feat/face/N`. Builds a box body, resolves face 0
// via the slash form against an empty repo (the geom-hash lookup misses, so the
// literal index 0 is used), and asserts the loops + plane equal the box[0]
// reference recorded for faceLoops (the frozen faceLoops.json snapshot; its
// generator gen_faceloops_fixture.py was removed in phase 4d).
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox, makeBoxAt, faceCentroid, faceNormal } from '../occ/primitives'
import { sortedFacesOf } from '../occ/faceLoops'
import { Repository } from '../query'
import { resolveFaceProfile, resolveFaceIndexViaHash } from './faceProfile'
import { faceGeometryHash } from '../geomHash'
import type { Body } from '../types3d'
import type { OccModule } from '../occ/occTypes'
import faceLoopsFixture from '../occ/__fixtures__/faceLoops.json'

const oc = await loadOcc()

const TOL = 1e-6
function expectClose(actual: unknown, expected: unknown, path = ''): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Math.abs(actual - expected), `${path}`).toBeLessThanOrEqual(TOL)
    return
  }
  if (Array.isArray(expected)) {
    const a = actual as unknown[]
    expect(a.length, `${path}: len`).toBe(expected.length)
    expected.forEach((e, i) => expectClose(a[i], e, `${path}[${i}]`))
    return
  }
  if (expected !== null && typeof expected === 'object') {
    const eo = expected as Record<string, unknown>
    const ao = actual as Record<string, unknown>
    expect(Object.keys(ao).sort(), `${path}: keys`).toEqual(Object.keys(eo).sort())
    for (const k of Object.keys(eo)) expectClose(ao[k], eo[k], `${path}.${k}`)
    return
  }
  expect(actual, path).toEqual(expected)
}

type FaceLoopsFx = {
  box: [number, number, number]
  cases: { shape: string; face_index: number; loops: unknown; plane: Record<string, number[]> }[]
}
const flx = faceLoopsFixture as unknown as FaceLoopsFx
const box0 = flx.cases.find((c) => c.shape === 'box' && c.face_index === 0)!

describe.skipIf(!oc)('resolveFaceProfile @feat/face/N (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('resolves a body face by slash form to its loops + plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const bodyStore: Record<string, Body> = {
        body_feat: {
          id: 'body_feat',
          created_by: 'feat',
          modified_by: [],
          shape: table.register(box, 'feat'),
          sketch_id: 'sk',
          brep_diff: null,
          profile_queries: [],
        },
      }
      const repo = new Repository()
      const { loops, plane, face } = resolveFaceProfile(
        occ,
        scope,
        table,
        '@feat/face/0',
        repo,
        bodyStore,
      )
      expectClose(loops, box0.loops, 'loops')
      expectClose(
        { origin: plane.origin, x_axis: plane.x_axis, y_axis: plane.y_axis, normal: plane.normal },
        box0.plane,
        'plane',
      )
      expect(face).not.toBeNull()
    } finally {
      scope.dispose()
    }
  })

  // One feature owns N bodies, so `@<id>/face/N` has to say WHICH body it
  // indexes into. The render fallback names the body (topoFallbackQuery), and
  // the resolver has to honour a sibling id exactly: reading `body_feat_1` as a
  // feature name looked up `body_body_feat_1`, missed, and fell back to a
  // created_by scan that always answered with sibling 0.
  it('resolves a split sibling body id to that sibling, not to sibling 0', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const SEP = 100
      const first = makeBox(occ, scope, 10, 10, 10)
      const second = makeBoxAt(occ, scope, [SEP, 0, 0], 10, 10, 10)
      const body = (id: string, shape: ReturnType<typeof makeBox>): Body => ({
        id,
        created_by: 'feat',
        modified_by: [],
        shape: table.register(shape, 'feat'),
        sketch_id: 'sk',
        brep_diff: null,
        profile_queries: [],
      })
      const bodyStore: Record<string, Body> = {
        body_feat: body('body_feat', first),
        body_feat_1: body('body_feat_1', second),
      }
      const repo = new Repository()
      const resolve = (ref: string) =>
        resolveFaceProfile(occ, scope, table, ref, repo, bodyStore).plane.origin

      const sibling0 = resolve('@body_feat/face/0')
      const sibling1 = resolve('@body_feat_1/face/0')
      // Same face index of two identical boxes: only the body they belong to
      // separates them, and that separation is exactly the x offset.
      expect(sibling1[0] - sibling0[0]).toBeCloseTo(SEP, 6)
      // A ref naming the FEATURE keeps its documented meaning: the first body.
      expect(resolve('@feat/face/0')).toEqual(sibling0)
    } finally {
      scope.dispose()
    }
  })

  // g1-H1: the persisted `@<body>/face/<N>` pick survives a rebuild. The remap
  // (resolveFaceIndexViaHash) finds the CURRENT face at the old index, looks up
  // its construction UUID in the body's face_names, and returns the repo's
  // face_index for that uuid. The repo registration below deliberately carries
  // a rebuilt index space (the pick named face 1, and after the rebuild that
  // face is registered at index 5), so a resolving remap must answer 5, not the
  // raw 1 -- and the fix under test is the `@u|` token: with the bare uuid the
  // UUID tier could never resolve and this returned null.
  it('remaps a UUID-bearing face to the rebuilt face index', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const faces = sortedFacesOf(occ, scope, box)
      expect(faces.length).toBe(6)
      const geomHashOf = (i: number) =>
        faceGeometryHash(faceCentroid(occ, scope, faces[i]), faceNormal(occ, scope, faces[i]))

      const uuids = faces.map((_, i) => `u_face${i}`)
      const faceNames: Record<string, string> = {}
      faces.forEach((_, i) => { faceNames[geomHashOf(i)] = uuids[i] })

      const rebuilt = [0, 5, 2, 3, 4, 1]
      const repo = new Repository()
      faces.forEach((_, i) => {
        repo.registerAncestor(
          ['@feat'],
          { type: 'face', body_id: 'body_feat', created_by: 'feat', face_index: rebuilt[i] },
          uuids[i],
        )
      })

      const bodyStore: Record<string, Body> = {
        body_feat: {
          id: 'body_feat',
          created_by: 'feat',
          modified_by: [],
          shape: table.register(box, 'feat'),
          sketch_id: 'sk',
          brep_diff: null,
          profile_queries: [],
          face_names: faceNames,
        },
      }
      const remapped = resolveFaceIndexViaHash(occ, scope, box, 1, repo, bodyStore, faceNames, faces)
      expect(remapped).toBe(5)
    } finally {
      scope.dispose()
    }
  })

  // g1-H1 fail-loud: a body that carries face identity but whose face at the
  // persisted index resolves to no registered element is a genuine remap miss.
  // Keeping the raw index would silently rebind the pick to the new occupant,
  // so the call site throws instead, naming the ref and the body.
  it('throws on a remap miss instead of silently keeping the raw index', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const faces = sortedFacesOf(occ, scope, box)
      const gh1 = faceGeometryHash(faceCentroid(occ, scope, faces[1]), faceNormal(occ, scope, faces[1]))
      const faceNames = { [gh1]: 'u_ghost' }  // a uuid with no registered element
      const bodyStore: Record<string, Body> = {
        body_feat: {
          id: 'body_feat',
          created_by: 'feat',
          modified_by: [],
          shape: table.register(box, 'feat'),
          sketch_id: 'sk',
          brep_diff: null,
          profile_queries: [],
          face_names: faceNames,
        },
      }
      const repo = new Repository()
      expect(() => resolveFaceProfile(occ, scope, table, '@body_feat/face/1', repo, bodyStore))
        .toThrow(/Cannot remap persisted face ref '@body_feat\/face\/1'/)
    } finally {
      scope.dispose()
    }
  })

  // The pre-sorted `faces` list is an optimization (M45): it must index the SAME
  // shape with the SAME sort as the internal traversal, or the remap answers
  // with a different face. Resolving the same pick both ways must agree.
  it('resolves the same remap with and without a pre-sorted face list', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const faces = sortedFacesOf(occ, scope, box)
      const geomHashOf = (i: number) =>
        faceGeometryHash(faceCentroid(occ, scope, faces[i]), faceNormal(occ, scope, faces[i]))
      const uuids = faces.map((_, i) => `u_face${i}`)
      const faceNames: Record<string, string> = {}
      faces.forEach((_, i) => { faceNames[geomHashOf(i)] = uuids[i] })

      const repo = new Repository()
      faces.forEach((_, i) => {
        repo.registerAncestor(
          ['@feat'],
          { type: 'face', body_id: 'body_feat', created_by: 'feat', face_index: i === 1 ? 5 : i },
          uuids[i],
        )
      })
      const bodyStore: Record<string, Body> = {
        body_feat: {
          id: 'body_feat',
          created_by: 'feat',
          modified_by: [],
          shape: table.register(box, 'feat'),
          sketch_id: 'sk',
          brep_diff: null,
          profile_queries: [],
          face_names: faceNames,
        },
      }

      const withFaces = resolveFaceIndexViaHash(occ, scope, box, 1, repo, bodyStore, faceNames, faces)
      const withoutFaces = resolveFaceIndexViaHash(occ, scope, box, 1, repo, bodyStore, faceNames)
      expect(withFaces).toBe(5)
      expect(withoutFaces).toBe(withFaces)
    } finally {
      scope.dispose()
    }
  })

  // A pre-sorted list is indexed in the same space as the shape, so an index at
  // its end must be refused (null), never read off the end as undefined.
  it('returns null for an index past the end of a pre-sorted face list', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const faces = sortedFacesOf(occ, scope, box)
      const repo = new Repository()
      expect(resolveFaceIndexViaHash(occ, scope, box, faces.length, repo, {}, undefined, faces)).toBeNull()
      // The internal traversal (no pre-sorted list) refuses the same index.
      expect(resolveFaceIndexViaHash(occ, scope, box, faces.length, repo, {})).toBeNull()
    } finally {
      scope.dispose()
    }
  })

  // A legacy ref `@<feature>/face/N` can name a FEATURE, not a body id. When no
  // `body_<id>` exists, the created_by scan answers with that feature's first
  // body; without it the ref resolves to nothing and the pick is lost.
  it('resolves a legacy feature-name ref to a body the feature created', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const SEP = 100
      const box = makeBoxAt(occ, scope, [SEP, 0, 0], flx.box[0], flx.box[1], flx.box[2])
      const bodyStore: Record<string, Body> = {
        body_other: {
          id: 'body_other',
          created_by: 'feat',
          modified_by: [],
          shape: table.register(box, 'feat'),
          sketch_id: 'sk',
          brep_diff: null,
          profile_queries: [],
        },
      }
      const repo = new Repository()
      const { plane } = resolveFaceProfile(occ, scope, table, '@feat/face/0', repo, bodyStore)
      expect(plane.origin[0]).toBeCloseTo(SEP, 6)
    } finally {
      scope.dispose()
    }
  })

  // The documented no-UUID path: a body with no face_names has nothing to remap
  // against, so the raw index is the only answer and is kept as-is. This is
  // what every plain sketch-extrude pick rides on, and what the extrude/plane
  // slash-ref real tests resolve.
  it('keeps the raw index for a body with no face identity', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const faces = sortedFacesOf(occ, scope, box)
      const bodyStore: Record<string, Body> = {
        body_feat: {
          id: 'body_feat',
          created_by: 'feat',
          modified_by: [],
          shape: table.register(box, 'feat'),
          sketch_id: 'sk',
          brep_diff: null,
          profile_queries: [],
        },
      }
      const repo = new Repository()
      expect(resolveFaceIndexViaHash(occ, scope, box, 1, repo, bodyStore, undefined, faces)).toBeNull()
      const { face } = resolveFaceProfile(occ, scope, table, '@body_feat/face/1', repo, bodyStore)
      expect(face).not.toBeNull()
    } finally {
      scope.dispose()
    }
  })
})
