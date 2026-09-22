// Always-on parity gate for the OCC-free `$sketch` path of collectExtrudeLoops
// (features/faceProfile.ts). Replays the frozen faceProfile golden fixture
// (its generator gen_faceprofile_fixture.py was removed with the Python kernel
// in phase 4d) and asserts the loops + plane + returned sketch id + registered
// top-face elements match the baseline (coords within 1e-9). No OCC needed on
// this path.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { collectExtrudeLoops, resolveFaceProfile } from './faceProfile'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'
import fixture from '../occ/__fixtures__/faceProfile.json'

const TOL = 1e-9

function expectClose(actual: unknown, expected: unknown, path = ''): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    expect(Math.abs(actual - expected), `${path}: ${actual} != ${expected}`).toBeLessThanOrEqual(TOL)
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

type Fixture = {
  sketch_id: string
  feature_id: string
  distance: number
  plane: Record<string, number[]>
  surfaces: Record<string, unknown>[]
  expected: {
    loops: Record<string, unknown>[][]
    plane: Record<string, number[]>
    returned_sketch_id: string
    top_face: Record<string, unknown>
  }
}
const fx = fixture as unknown as Fixture

// collectExtrudeLoops never touches `oc`/`table` on the `$sketch` path.
const oc = null as unknown as OccModule
const table = null as unknown as HandleTable

describe('collectExtrudeLoops $sketch path parity', () => {
  it('reads topology, registers top face, assembles loops', () => {
    const repo = new Repository()
    repo.register('_pt_' + fx.sketch_id, { ...fx.plane })
    repo.register('_topo_' + fx.sketch_id, { surfaces: fx.surfaces.map((s) => ({ ...s })) })

    const bodyStore: Record<string, Body> = {}
    const result = collectExtrudeLoops(
      oc,
      null as never,
      table,
      '$' + fx.sketch_id,
      repo,
      bodyStore,
    )

    expectClose(result.loops, fx.expected.loops, 'loops')
    expectClose(
      {
        origin: result.plane.origin,
        x_axis: result.plane.x_axis,
        y_axis: result.plane.y_axis,
        normal: result.plane.normal,
      },
      fx.expected.plane,
      'plane',
    )
    expect(result.sketchId).toBe(fx.expected.returned_sketch_id)
    expect(result.face).toBeNull()

    // top-face registration is now done by the caller (extrude.ts) after
    // resolveDirection, so collectExtrudeLoops no longer has this side effect.
  })
})

describe('resolveFaceProfile repo face entry guards', () => {
  it('refuses a face entry whose body is gone or has no shape', () => {
    // A repo face entry carries body_id + face_index; a stale entry naming a
    // deleted body must fail by name rather than dereference a missing body.
    const repo = new Repository()
    repo.register('faceRef', { body_id: 'missing_body', face_index: 0 })
    expect(() =>
      resolveFaceProfile(oc, null as never, table, '@faceRef', repo, {}),
    ).toThrow(/Body 'missing_body' not found or has no shape/)
  })
})
