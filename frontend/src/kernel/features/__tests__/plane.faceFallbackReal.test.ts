// @vitest-environment node
//
// Gated real-OCC gate for the on_face plane mode resolving a topo-fallback
// `@body/face/N` face pick (features/plane.ts). Faces register in the repo
// under ancestry keys, never under the slash key, so repo.query alone cannot
// answer the ref; the frame has to come from the body's OCC shape through the
// same path the extrude-on-face profile uses (features/faceProfile.ts). Builds
// a box and asserts the solved plane matches that face's own live outward
// normal and centroid (the H22 fix), not the raw surface frame.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox, makeBoxAt, faceCentroid, faceNormal } from '../../occ/primitives'
import { Repository } from '../../query'
import { solvePlane } from '../plane'
import { extractOccFace } from '../../occ/faceLoops'
import type { Body } from '../../types3d'
import type { OccModule } from '../../occ/occTypes'
import faceLoopsFixture from '../../occ/__fixtures__/faceLoops.json'

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
}
const flx = faceLoopsFixture as unknown as FaceLoopsFx

describe.skipIf(!oc)('solvePlane on_face topo-fallback (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('solves an on_face plane from a @body/face/N pick', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      // Compute expected centroid + normal before detaching the shape.
      const expectedNormal = faceNormal(occ, scope, extractOccFace(occ, scope, box, 0))
      const expectedCentroid = faceCentroid(occ, scope, extractOccFace(occ, scope, box, 0))
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

      const res = solvePlane(
        occ, scope, table,
        { id: 'pl', kind: 'plane', definition: { mode: 'on_face', face: '@body_feat/face/0' } },
        repo, bodyStore,
      )

      expect(res.status).toBe('ok')
      // The on_face plane must use the outward normal and face centroid,
      // not the raw surface frame (H22 fix).
      expectClose(res.plane.origin, expectedCentroid, 'plane.origin')
      expectClose(res.plane.normal, expectedNormal, 'plane.normal')
    } finally {
      scope.dispose()
    }
  })

  it('resolves a split sibling body id to that sibling, not to sibling 0', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const SEP = 100
      const first = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const second = makeBoxAt(occ, scope, [SEP, 0, 0], flx.box[0], flx.box[1], flx.box[2])
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
      const originFor = (ref: string) =>
        solvePlane(occ, scope, table, { id: 'pl', kind: 'plane', definition: { mode: 'on_face', face: ref } }, repo, bodyStore).plane.origin

      const sibling0 = originFor('@body_feat/face/0')
      const sibling1 = originFor('@body_feat_1/face/0')
      // Same face index of two identical boxes: only the body they belong to
      // separates them, and that separation is exactly the x offset.
      expect(sibling1[0] - sibling0[0]).toBeCloseTo(SEP, 6)
    } finally {
      scope.dispose()
    }
  })
})
