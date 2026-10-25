// @vitest-environment node
//
// A circular array honours its stored `axis_origin` + `axis_direction` pair.
// The schema offered the pair but the leaf read only `axis`, so a document that
// stored the pair solved to "axis is required" (candleStand F3, sprocket F2).
// The precedence matches transform: an `axis` pick wins over the pair.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt, solidCentroid } from '../../occ/primitives'
import { Repository } from '../../query'
import { bareBody } from '../shared/bodyResolution'
import { solveCircularArray } from '../array'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const loadedOcc = await loadOcc()
const oc = loadedOcc!

function run(sub: Record<string, unknown>, repo = new Repository()) {
  const scope = new DisposeScope()
  const table = new HandleTable()
  const body = bareBody('body_src', 'src')
  // A 10 mm cube centred at x=20, off the Y axis.
  body.shape = table.register(makeBoxAt(oc, scope, [15, -5, -5], 10, 10, 10), body.created_by)
  const store: Record<string, Body> = { body_src: body }
  const res = solveCircularArray(oc, scope, table, {
    id: 'ca1',
    circular_array: { source_body: '@body_src', count: 4, step_angle: 90, operation: 'new', ...sub },
  }, repo, store)
  // `operation: new` keeps the source as instance 0; body_ids lists the copies.
  const ids = [...new Set(['body_src', ...(res.body_ids as string[])])]
  const centroids = ids.map((id) =>
    solidCentroid(oc, scope, table.get<OccShape>(store[id].shape!)).map((c) => Math.round(c * 1000) / 1000 + 0))
  scope.dispose()
  return centroids
}

const sortKey = (c: number[]) => c.join(',')

describe.skipIf(!loadedOcc)('circular_array axis_origin + axis_direction', () => {
  it('rotates about the stored pair when no axis pick is given', () => {
    const centroids = run({ axis_origin: [0, 0, 0], axis_direction: [0, 1, 0] })
    expect(centroids).toHaveLength(4)
    const want = [[20, 0, 0], [0, 0, -20], [-20, 0, 0], [0, 0, 20]]
    expect(centroids.map(sortKey).sort()).toEqual(want.map(sortKey).sort())
  })

  it('lets an axis pick win over the stored pair', () => {
    const repo = new Repository()
    repo.register('axis_z', { start: [0, 0, 0], end: [0, 0, 1] })
    const centroids = run({ axis: '@axis_z', axis_origin: [0, 0, 0], axis_direction: [0, 1, 0] }, repo)
    const want = [[20, 0, 0], [0, 20, 0], [-20, 0, 0], [0, -20, 0]]
    expect(centroids.map(sortKey).sort()).toEqual(want.map(sortKey).sort())
  })

  it('names the pair when neither is given', () => {
    expect(() => run({})).toThrow(/axis_origin.*axis_direction/)
  })
})
