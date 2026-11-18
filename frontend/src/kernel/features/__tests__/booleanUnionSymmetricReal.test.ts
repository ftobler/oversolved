// @vitest-environment node
//
// A union (and an intersect) is a set of bodies, not a target plus tools: the
// first pick is only the base that keeps the body's identity, and the picks
// after it must not change the geometry by their order. The leaf folds the tools
// in connectivity order from the base, so a chain A-B-C comes out the same when
// picked as [A, C, B] (C only reaches A through B) as when picked [A, B, C].
//
// A pick that connects to nothing in the base's component is skipped with the
// same warning a cut already gives, and its body is left in the store.
//
// Skips when the OCC build is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { countSubShapes, volumeOf } from '../../occ/booleans'
import { makeBoxAt } from '../../occ/primitives'
import { Repository } from '../../query'
import { barePart } from '../shared/partResolution'
import { solveBoolean } from '../boolean'
import type { PartSolid } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const loadedOcc = await loadOcc()
const hasOcc = loadedOcc !== null
const oc = loadedOcc!

interface Rig {
  scope: DisposeScope
  table: HandleTable
  store: Record<string, PartSolid>
}

function rig(): Rig {
  return { scope: new DisposeScope(), table: new HandleTable(), store: {} }
}

function seedBox(r: Rig, id: string, x: number): void {
  const part = barePart(id, id)
  part.shape = r.table.register(makeBoxAt(oc, r.scope, [x, 0, 0], 10, 10, 10), id)
  r.store[id] = part
}

function volume(r: Rig, id: string): number {
  return volumeOf(oc, r.scope, r.table.get<OccShape>(r.store[id].shape!))
}

function faces(r: Rig, id: string): number {
  return countSubShapes(oc, r.scope, r.table.get<OccShape>(r.store[id].shape!), oc.TopAbs_ShapeEnum.TopAbs_FACE)
}

/** A-B-C in a chain: A at 0, B at 8, C at 16. B overlaps both, A and C are
 *  apart, so C can only reach the base through B. */
function seedChain(r: Rig): void {
  seedBox(r, 'body_a', 0)
  seedBox(r, 'body_b', 8)
  seedBox(r, 'body_c', 16)
}

function unionChain(base: string, tools: string[]): { volume: number; faces: number; partIds: string[]; store: string[] } {
  const r = rig()
  seedChain(r)
  const res = solveBoolean(oc, r.scope, r.table, {
    id: 'bool1', boolean: { operation: 'union', target: base, tools },
  }, new Repository(), r.store)
  const out = {
    volume: volume(r, base),
    faces: faces(r, base),
    partIds: res.body_ids,
    store: Object.keys(r.store).sort(),
  }
  r.scope.dispose()
  return out
}

describe.skipIf(!hasOcc)('boolean union: the tools are a set, not a list order', () => {
  it('a chain picked [A, C, B] and [A, B, C] gives the same one body', () => {
    // A geometry-equality guard, not the ordering regression pin: a fuse is
    // associative, so the old list-order fold joined this chain too. The
    // ordering pin is the mock test in boolean.test.ts ("folds in connectivity
    // order from the base, not in pick order"), which asserts the call sequence;
    // the skip case below pins the semantic change.
    const tailFirst = unionChain('body_a', ['body_c', 'body_b'])
    const inOrder = unionChain('body_a', ['body_b', 'body_c'])

    expect(tailFirst.partIds).toEqual(['body_a'])
    expect(inOrder.partIds).toEqual(['body_a'])
    expect(tailFirst.store).toEqual(['body_a'])
    expect(inOrder.store).toEqual(['body_a'])
    expect(tailFirst.volume).toBeCloseTo(inOrder.volume, 3)
    expect(tailFirst.faces).toBe(inOrder.faces)
    // Three overlapping 10 mm boxes: the union is larger than the base alone.
    expect(tailFirst.volume).toBeGreaterThan(1000)
  })

  it('only the base pick decides which body survives', () => {
    const aBase = unionChain('body_a', ['body_b', 'body_c'])
    const bBase = unionChain('body_b', ['body_a', 'body_c'])

    expect(aBase.partIds).toEqual(['body_a'])
    expect(bBase.partIds).toEqual(['body_b'])
    // Same material, same face count; the surviving id follows the first pick.
    expect(aBase.volume).toBeCloseTo(bBase.volume, 3)
    expect(aBase.faces).toBe(bBase.faces)
  })

  it('a pick that connects to nothing is skipped, and its body survives', () => {
    const r = rig()
    seedBox(r, 'body_a', 0)
    seedBox(r, 'body_b', 8)
    seedBox(r, 'body_far', 100)

    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'union', target: 'body_a', tools: ['body_far', 'body_b'] },
    }, new Repository(), r.store)

    expect(res.solver_warning).toContain("union: tool 'body_far' does not intersect the target; skipped")
    expect(res.body_ids).toEqual(['body_a'])
    // The joined pair is one body; the disconnected pick was not consumed.
    expect(Object.keys(r.store).sort()).toEqual(['body_a', 'body_far'])
    expect(volume(r, 'body_a')).toBeCloseTo(2000 - 10 * 2 * 10, 3)
    expect(volume(r, 'body_far')).toBeCloseTo(1000, 3)
    r.scope.dispose()
  })

  it('a pick that only reaches the base through another skipped pick is skipped too', () => {
    const r = rig()
    seedBox(r, 'body_a', 0)
    // B and C touch each other, far from A: neither is in A's component.
    seedBox(r, 'body_b', 40)
    seedBox(r, 'body_c', 48)

    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'union', target: 'body_a', tools: ['body_b', 'body_c'] },
    }, new Repository(), r.store)

    expect(res.solver_warning).toContain("tool 'body_b' does not intersect the target; skipped")
    expect(res.solver_warning).toContain("tool 'body_c' does not intersect the target; skipped")
    expect(res.body_ids).toEqual(['body_a'])
    expect(Object.keys(r.store).sort()).toEqual(['body_a', 'body_b', 'body_c'])
    expect(volume(r, 'body_a')).toBeCloseTo(1000, 3)
    r.scope.dispose()
  })
})

describe.skipIf(!hasOcc)('boolean intersect: the same base rule', () => {
  it('folds the same pick set to the same intersection in either pick order', () => {
    const run = (tools: string[]) => {
      const r = rig()
      seedBox(r, 'body_a', 0)
      seedBox(r, 'body_b', 4)
      seedBox(r, 'body_c', 2)
      const res = solveBoolean(oc, r.scope, r.table, {
        id: 'bool1', boolean: { operation: 'intersect', target: 'body_a', tools },
      }, new Repository(), r.store)
      const out = {
        volume: volume(r, 'body_a'),
        faces: faces(r, 'body_a'),
        partIds: res.body_ids,
        store: Object.keys(r.store).sort(),
      }
      r.scope.dispose()
      return out
    }

    const tailFirst = run(['body_c', 'body_b'])
    const inOrder = run(['body_b', 'body_c'])
    expect(tailFirst.partIds).toEqual(['body_a'])
    expect(inOrder.partIds).toEqual(['body_a'])
    expect(tailFirst.store).toEqual(['body_a'])
    expect(inOrder.store).toEqual(['body_a'])
    expect(tailFirst.volume).toBeCloseTo(inOrder.volume, 3)
    expect(tailFirst.faces).toBe(inOrder.faces)
    // A 0..10, B 4..14, C 2..12: the common is the 4..10 slab.
    expect(tailFirst.volume).toBeCloseTo(10 * 10 * 6, 3)
  })
})
