// @vitest-environment node
//
// Real-OCC geometry for transform.rotation_euler. The branch suite stubs the
// trsf constructors, so it can prove only the conflict refusal; here the composed
// rotation is applied to a real box and its bounding box and volume are read
// back. Skips when opencascade.js is absent, like the other real-kernel leaves.
//
// The convention is extrinsic XYZ: rotate about world X first, then world Y,
// then world Z. The order test uses a box that is not symmetric under the two
// orders, so running Z first would land a different box.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt, readSolidVertices, type Vec3 } from '../../occ/primitives'
import { volumeOf } from '../../occ/booleans'
import { Repository } from '../../query'
import { solveTransform } from '../transformMirror'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { Body } from '../../types3d'

const oc = await loadOcc()

type Bbox6 = [number, number, number, number, number, number]
type Store = Record<string, Body>

function makeBoxBody(
  occ: OccModule, scope: DisposeScope, table: HandleTable,
  origin: Vec3, size: Vec3, id = 'body_s',
): Body {
  const box = makeBoxAt(occ, scope, origin, size[0], size[1], size[2])
  return {
    id,
    created_by: 'ex_s',
    modified_by: [],
    shape: table.register(box, 'ex_s'),
    sketch_id: 'sk_s',
    brep_diff: null,
    profile_queries: [],
  }
}

function bbox6(occ: OccModule, scope: DisposeScope, table: HandleTable, body: Body): Bbox6 {
  const verts = readSolidVertices(occ, scope, table.get<OccShape>(body.shape!))
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < lo[i]) lo[i] = v[i]
      if (v[i] > hi[i]) hi[i] = v[i]
    }
  }
  return [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]
}

function bodyVolume(occ: OccModule, scope: DisposeScope, table: HandleTable, body: Body): number {
  return volumeOf(occ, scope, table.get<OccShape>(body.shape!))
}

function expectBboxClose(actual: Bbox6, expected: Bbox6, digits = 6): void {
  for (let i = 0; i < 6; i++) expect(actual[i], `bbox[${i}]`).toBeCloseTo(expected[i], digits)
}

describe.skipIf(!oc)('transform.rotation_euler (real OCC)', () => {
  it('maps +X to +Y for rotation_euler [0, 0, 90]', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Store = { body_s: makeBoxBody(oc!, scope, table, [0, 0, 0], [10, 2, 3]) }
      const result = solveTransform(oc!, scope, table, {
        id: 'tr1',
        kind: 'transform',
        transform: { bodies: ['body_s'], operation: 'new', rotation_euler: [0, 0, 90] },
      }, new Repository(), store)
      expect(result.status).toBe('ok')
      expectBboxClose(bbox6(oc!, scope, table, store[result.body_id as string]), [-2, 0, 0, 0, 10, 3])
    } finally {
      scope.dispose()
    }
  })

  it('applies X first, then Y, then Z about the world axes', () => {
    // R = Rz(90) * Ry(0) * Rx(90), so (x, y, z) lands at (z, x, y). A 2 x 5 x 3
    // box becomes a 3 x 2 x 5 box. Running Z first would put it at x [-5, 0],
    // y [-3, 0].
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Store = { body_s: makeBoxBody(oc!, scope, table, [0, 0, 0], [2, 5, 3]) }
      const result = solveTransform(oc!, scope, table, {
        id: 'tr1',
        kind: 'transform',
        transform: { bodies: ['body_s'], operation: 'new', rotation_euler: [90, 0, 90] },
      }, new Repository(), store)
      expect(result.status).toBe('ok')
      expectBboxClose(bbox6(oc!, scope, table, store[result.body_id as string]), [0, 0, 0, 3, 2, 5])
    } finally {
      scope.dispose()
    }
  })

  it('solves an all-zero triple as identity', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store: Store = { body_s: makeBoxBody(oc!, scope, table, [1, 2, 3], [4, 2, 3]) }
      const before = bodyVolume(oc!, scope, table, store.body_s)
      const result = solveTransform(oc!, scope, table, {
        id: 'tr1',
        kind: 'transform',
        transform: { bodies: ['body_s'], operation: 'new', rotation_euler: [0, 0, 0] },
      }, new Repository(), store)
      expect(result.status).toBe('ok')
      const moved = store[result.body_id as string]
      expectBboxClose(bbox6(oc!, scope, table, moved), [1, 2, 3, 5, 4, 6])
      expect(bodyVolume(oc!, scope, table, moved)).toBeCloseTo(before, 9)
    } finally {
      scope.dispose()
    }
  })

  it('matches three chained world-axis transforms for [10, 20, 300]', () => {
    const size: Vec3 = [4, 2, 6]
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const eulerStore: Store = { body_s: makeBoxBody(oc!, scope, table, [0, 0, 0], size) }
      const euler = solveTransform(oc!, scope, table, {
        id: 'tr_e',
        kind: 'transform',
        transform: { bodies: ['body_s'], operation: 'replace', rotation_euler: [10, 20, 300] },
      }, new Repository(), eulerStore)
      expect(euler.status).toBe('ok')

      const chainStore: Store = { body_s: makeBoxBody(oc!, scope, table, [0, 0, 0], size) }
      for (const [id, axis, angle] of [
        ['tr_x', [1, 0, 0], 10],
        ['tr_y', [0, 1, 0], 20],
        ['tr_z', [0, 0, 1], 300],
      ] as const) {
        const step = solveTransform(oc!, scope, table, {
          id,
          kind: 'transform',
          transform: {
            bodies: ['body_s'],
            operation: 'replace',
            rotation_angle: angle,
            rotation_axis_origin: [0, 0, 0],
            rotation_axis_direction: axis,
          },
        }, new Repository(), chainStore)
        expect(step.status, id).toBe('ok')
      }

      const eulerBbox = bbox6(oc!, scope, table, eulerStore.body_s)
      const chainBbox = bbox6(oc!, scope, table, chainStore.body_s)
      expectBboxClose(eulerBbox, chainBbox)
      expect(bodyVolume(oc!, scope, table, eulerStore.body_s))
        .toBeCloseTo(bodyVolume(oc!, scope, table, chainStore.body_s), 9)
    } finally {
      scope.dispose()
    }
  })

  it('pivots about rotation_axis_origin instead of the world origin', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      // A 4 x 2 x 2 box centred on (10, 0, 0) keeps that centre under the turn.
      const store: Store = { body_s: makeBoxBody(oc!, scope, table, [8, -1, -1], [4, 2, 2]) }
      const result = solveTransform(oc!, scope, table, {
        id: 'tr1',
        kind: 'transform',
        transform: {
          bodies: ['body_s'],
          operation: 'new',
          rotation_euler: [0, 0, 90],
          rotation_axis_origin: [10, 0, 0],
        },
      }, new Repository(), store)
      expect(result.status).toBe('ok')
      expectBboxClose(bbox6(oc!, scope, table, store[result.body_id as string]), [9, -2, -1, 11, 2, 1])
    } finally {
      scope.dispose()
    }
  })
})
