// @vitest-environment node
//
// The array-add identity gate: a disjoint array must leave the source body's id
// on the source material.
//
// Before the fix, the split siblings were ordered by centroid and the source
// body kept the first slot, so an array that ran toward -Z handed `body_src` to
// a copy at a smaller z (the din-rail repro: `body_ex2` named z=175 instead of
// the source at z=75). A later boolean on that id then silently hit a copy. The
// fix passes the source solid through by topological identity, not geometry.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { booleanWithDiff, volumeOf } from '../../occ/booleans'
import { makeBoxAt, solidCentroid } from '../../occ/primitives'
import { Repository } from '../../query'
import { bareBody } from '../shared/bodyResolution'
import { solveArray } from '../array'
import { solveBoolean } from '../boolean'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const loadedOcc = await loadOcc()
const hasOcc = loadedOcc !== null
const oc = loadedOcc!

interface Rig {
  scope: DisposeScope
  table: HandleTable
  store: Record<string, Body>
}

function rig(): Rig {
  return { scope: new DisposeScope(), table: new HandleTable(), store: {} }
}

/** A U-channel along Z, the din-rail cross-section: a base flange plus two
 *  side walls, fused into one solid. */
function railShape(r: Rig): OccShape {
  const base = makeBoxAt(oc, r.scope, [0, 0, 200], 40, 20, 5)
  const wallA = makeBoxAt(oc, r.scope, [0, 0, 205], 5, 20, 25)
  const wallB = makeBoxAt(oc, r.scope, [35, 0, 205], 5, 20, 25)
  const first = booleanWithDiff(oc, r.scope, base, wallA, 'fuse').shape
  return r.scope.track(booleanWithDiff(oc, r.scope, first, wallB, 'fuse').shape)
}

function seedRail(r: Rig): Body {
  const body = bareBody('body_src', 'src')
  body.shape = r.table.register(r.scope.detach(railShape(r)), body.created_by)
  r.store.body_src = body
  return body
}

function centroidZ(r: Rig, id: string): number {
  return solidCentroid(oc, r.scope, r.table.get<OccShape>(r.store[id].shape!))[2]
}

function volume(r: Rig, id: string): number {
  return volumeOf(oc, r.scope, r.table.get<OccShape>(r.store[id].shape!))
}

describe.skipIf(!hasOcc)('array add: the source keeps its id across a disjoint split', () => {
  it('keeps the source id and centroid on a 4x array running toward -Z', () => {
    const r = rig()
    const source = seedRail(r)
    const sourceCentroid = solidCentroid(oc, r.scope, r.table.get<OccShape>(source.shape!))
    const sourceZ = sourceCentroid[2]

    const repo = new Repository()
    // -Z, so the copies sit at a SMALLER centroid than the source: the old
    // centroid ranking put the first copy first and the source on body_src_3.
    repo.elements.set('dz', { start: [0, 0, 0], end: [0, 0, -1] })
    const res = solveArray(oc, r.scope, r.table, {
      id: 'ar1',
      array: {
        source_body: '@body_src', mode: 'linear', operation: 'add', include_source: true,
        count_x: 4, pitch_x: 100, direction_x_query: '@dz',
      },
    }, repo, r.store)

    expect(res.body_ids).toEqual(['body_src', 'body_src_1', 'body_src_2', 'body_src_3'])
    // The body OBJECT and the id both stay on the source.
    expect(r.store.body_src).toBe(source)
    const kept = solidCentroid(oc, r.scope, r.table.get<OccShape>(r.store.body_src.shape!))
    for (let i = 0; i < 3; i++) expect(kept[i]).toBeCloseTo(sourceCentroid[i], 9)
    expect(sourceZ).toBeGreaterThan(200)
    // The copies are the lower ones; their suffixes follow the relative sibling
    // order (ascending centroid), which is the existing naming key and is not
    // what this test changes. What matters is that none of them is the source.
    const copyZ = ['body_src_1', 'body_src_2', 'body_src_3']
      .map((id) => centroidZ(r, id))
      .sort((a, b) => a - b)
    expect(copyZ[0]).toBeCloseTo(sourceZ - 300, 6)
    expect(copyZ[1]).toBeCloseTo(sourceZ - 200, 6)
    expect(copyZ[2]).toBeCloseTo(sourceZ - 100, 6)
    r.scope.dispose()
  })

  it('a later cut targeting the source id hits the source, not a copy', () => {
    const r = rig()
    seedRail(r)
    const repo = new Repository()
    repo.elements.set('dz', { start: [0, 0, 0], end: [0, 0, -1] })
    solveArray(oc, r.scope, r.table, {
      id: 'ar1',
      array: {
        source_body: '@body_src', mode: 'linear', operation: 'add', include_source: true,
        count_x: 4, pitch_x: 100, direction_x_query: '@dz',
      },
    }, repo, r.store)

    const before = Object.fromEntries(
      ['body_src', 'body_src_1', 'body_src_2', 'body_src_3'].map((id) => [id, volume(r, id)]),
    )

    // A notch in one corner of the source's base flange only.
    const tool = bareBody('body_tool', 'tool')
    tool.shape = r.table.register(makeBoxAt(oc, r.scope, [-1, -1, 199], 10, 10, 7), 'tool')
    r.store.body_tool = tool
    const cut = solveBoolean(oc, r.scope, r.table, {
      id: 'cut1', boolean: { operation: 'subtract', target: '@body_src', tools: ['@body_tool'] },
    }, new Repository(), r.store)
    expect(cut.body_ids).toEqual(['body_src'])

    // The source lost material; every copy is untouched. A centroid re-rank
    // would have cut the copy at z=115 and left the rail at z=215 alone.
    expect(volume(r, 'body_src')).toBeLessThan(before.body_src - 100)
    for (const id of ['body_src_1', 'body_src_2', 'body_src_3']) {
      expect(volume(r, id)).toBeCloseTo(before[id], 6)
    }
    r.scope.dispose()
  })
})
