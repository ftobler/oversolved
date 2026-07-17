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
import { makeBox } from '../occ/primitives'
import { Repository } from '../query'
import { resolveFaceProfile } from './faceProfile'
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
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const box = makeBox(occ, scope, flx.box[0], flx.box[1], flx.box[2])
      const bodyStore: Record<string, Body> = {
        body_feat: {
          id: 'body_feat',
          created_by: 'feat',
          modified_by: [],
          shape: table.register(scope.detach(box), 'feat'),
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
})
