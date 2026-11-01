// @vitest-environment node
//
// `@<arrayId>` in a boolean tool list must stand for every body the array is,
// including the `<source>_N` copies an `operation: add` array splits into.
//
// The repro (MCP practice `06_other__...car-wheel`, F4): a hub, six spokes made
// by a circular add array, and a boolean that unions `@ca1` into the hub. The
// copies of a disjoint add array are minted by `resplitBody`, which hands them
// the SOURCE body's `created_by` (`ex2`), so `created_by === 'ca1'` never
// matched them and the boolean fused only the source spoke. Listing the ids by
// hand worked, which is the tell.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { booleanWithDiff, volumeOf } from '../../occ/booleans'
import { makeBoxAt, makeCylinder } from '../../occ/primitives'
import { Repository } from '../../query'
import { bareBody } from '../shared/bodyResolution'
import { solveArray, solveCircularArray } from '../array'
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

function seed(r: Rig, id: string, createdBy: string, shape: OccShape): Body {
  const body = bareBody(id, createdBy)
  body.shape = r.table.register(r.scope.detach(r.scope.track(shape)), createdBy)
  r.store[id] = body
  return body
}

function volume(r: Rig, id: string): number {
  return volumeOf(oc, r.scope, r.table.get<OccShape>(r.store[id].shape!))
}

// A hub plate in the XZ plane: the car wheel's centre disc.
function hubShape(r: Rig): OccShape {
  return makeBoxAt(oc, r.scope, [-20, -5, -20], 40, 10, 40)
}

// One spoke along +X, its inner end buried in the hub so every instance fuses
// with it. Six of these at 60 deg are disjoint from each other (the gap at the
// innermost radius is wider than the spoke).
function spokeShape(r: Rig): OccShape {
  return makeBoxAt(oc, r.scope, [10, -4, -4], 40, 8, 8)
}

// The rim: a ring around Y whose inner wall overlaps every spoke's outer end
// and never reaches the hub.
function rimShape(r: Rig): OccShape {
  const outer = makeCylinder(oc, r.scope, [0, -4, 0], [0, 1, 0], 52, 8)
  const inner = makeCylinder(oc, r.scope, [0, -4, 0], [0, 1, 0], 44, 8)
  return booleanWithDiff(oc, r.scope, outer, inner, 'cut').shape
}

function seedWheel(r: Rig): void {
  seed(r, 'body_ex1', 'ex1', hubShape(r))
  seed(r, 'body_ex2', 'ex2', spokeShape(r))
}

const CA1 = {
  source_body: '@body_ex2', count: 6, operation: 'add',
  axis_origin: [0, 0, 0], axis_direction: [0, 1, 0],
}

/** The feature definitions a build hands the leaf, keyed by id: an array ref
 *  only expands when its own definition is in this map. */
function solvedArrays(...defs: [string, string, Record<string, unknown>][]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(defs.map(([id, kind, sub]) => [id, { id, kind, [kind]: sub }]))
}

/** The repro's six-spoke wheel, optionally with the rim step that modifies the
 *  source spoke after the array. Returns the union's result. */
function unionArrayIntoHub(r: Rig, withRim: boolean) {
  solveCircularArray(oc, r.scope, r.table, { id: 'ca1', circular_array: CA1 }, new Repository(), r.store)
  if (withRim) {
    seed(r, 'body_ex3', 'ex3', rimShape(r))
    solveBoolean(oc, r.scope, r.table, {
      id: 'ex3', boolean: { operation: 'union', target: '@body_ex2', tools: ['@body_ex3'] },
    }, new Repository(), r.store)
  }
  return solveBoolean(oc, r.scope, r.table, {
    id: 'bool1', boolean: { operation: 'union', target: '@body_ex1', tools: ['@ca1'] },
  }, new Repository(), r.store, solvedArrays(['ca1', 'circular_array', CA1]))
}

describe.skipIf(!hasOcc)('boolean tools: @array includes the copies an add array split into', () => {
  it('unions every spoke of a disjoint circular add array into the hub', () => {
    const r = rig()
    seedWheel(r)
    const res = unionArrayIntoHub(r, false)

    // Six disjoint copies plus the source body were all folded in, so the wheel
    // is one connected solid and the parts list holds one row.
    expect(res.body_ids).toHaveLength(1)
    expect(Object.keys(r.store)).toHaveLength(1)

    // The same union by explicit id gives the same volume: nothing was skipped.
    const explicit = rig()
    seedWheel(explicit)
    solveCircularArray(oc, explicit.scope, explicit.table, { id: 'ca1', circular_array: CA1 }, new Repository(), explicit.store)
    const copyIds = Object.keys(explicit.store).filter((id) => id !== 'body_ex1')
    expect(copyIds).toHaveLength(6)
    const byHand = solveBoolean(oc, explicit.scope, explicit.table, {
      id: 'bool1', boolean: { operation: 'union', target: '@body_ex1', tools: copyIds },
    }, new Repository(), explicit.store, solvedArrays(['ca1', 'circular_array', CA1]))
    expect(byHand.body_ids).toHaveLength(1)
    expect(volume(r, res.body_ids[0])).toBeCloseTo(volume(explicit, byHand.body_ids[0]), 3)

    r.scope.dispose()
    explicit.scope.dispose()
  }, 60_000)

  it('keeps the copies when a later feature modifies the source spoke', () => {
    const r = rig()
    seedWheel(r)
    const res = unionArrayIntoHub(r, true)

    expect(res.body_ids).toHaveLength(1)
    expect(Object.keys(r.store)).toHaveLength(1)

    const explicit = rig()
    seedWheel(explicit)
    solveCircularArray(oc, explicit.scope, explicit.table, { id: 'ca1', circular_array: CA1 }, new Repository(), explicit.store)
    seed(explicit, 'body_ex3', 'ex3', rimShape(explicit))
    solveBoolean(oc, explicit.scope, explicit.table, {
      id: 'ex3', boolean: { operation: 'union', target: '@body_ex2', tools: ['@body_ex3'] },
    }, new Repository(), explicit.store)
    const copyIds = Object.keys(explicit.store).filter((id) => id !== 'body_ex1')
    const byHand = solveBoolean(oc, explicit.scope, explicit.table, {
      id: 'bool1', boolean: { operation: 'union', target: '@body_ex1', tools: copyIds },
    }, new Repository(), explicit.store, solvedArrays(['ca1', 'circular_array', CA1]))
    expect(byHand.body_ids).toHaveLength(1)
    expect(volume(r, res.body_ids[0])).toBeCloseTo(volume(explicit, byHand.body_ids[0]), 3)

    r.scope.dispose()
    explicit.scope.dispose()
  }, 60_000)

  it('a linear add array with a wide pitch: @ar1 as a subtract tool removes every copy', () => {
    const r = rig()
    const plate = makeBoxAt(oc, r.scope, [-20, -10, -10], 340, 20, 20)
    seed(r, 'body_plate', 'plate', plate)
    seed(r, 'body_spoke', 'sp0', spokeShape(r))
    const ar1 = {
      source_body: '@body_spoke', mode: 'linear', operation: 'add', include_source: true,
      count_x: 3, pitch_x: 100, direction_x: [1, 0, 0],
    }
    solveArray(oc, r.scope, r.table, { id: 'ar1', array: ar1 }, new Repository(), r.store)
    expect(Object.keys(r.store)).toHaveLength(4)

    const plateBefore = volume(r, 'body_plate')
    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'subtract', target: '@body_plate', tools: ['@ar1'] },
    }, new Repository(), r.store, solvedArrays(['ar1', 'array', ar1]))

    // Every copy was cut out and consumed; only the plate is left.
    expect(res.body_ids).toEqual(['body_plate'])
    expect(Object.keys(r.store)).toEqual(['body_plate'])
    expect(volume(r, 'body_plate')).toBeCloseTo(plateBefore - 3 * 40 * 8 * 8, 3)
    r.scope.dispose()
  })

  it('a nested add array owns its copies, not the outer array', () => {
    const r = rig()
    // Deep enough in Y and Z to hold the inner array's Z-offset copy.
    const plate = makeBoxAt(oc, r.scope, [-20, -30, -20], 340, 60, 100)
    seed(r, 'body_plate', 'plate', plate)
    seed(r, 'body_spoke', 'sp0', spokeShape(r))
    const outer = {
      source_body: '@body_spoke', mode: 'linear', operation: 'add', include_source: true,
      count_x: 2, pitch_x: 100, direction_x: [1, 0, 0],
    }
    solveArray(oc, r.scope, r.table, { id: 'arA', array: outer }, new Repository(), r.store)
    // The inner array takes one OUTER copy as its source and arrays it along Z.
    const inner = {
      source_body: '@body_spoke_1', mode: 'linear', operation: 'add', include_source: true,
      count_x: 2, pitch_x: 30, direction_x: [0, 0, 1],
    }
    solveArray(oc, r.scope, r.table, { id: 'arB', array: inner }, new Repository(), r.store)
    expect(Object.keys(r.store)).toHaveLength(4)

    const plateBefore = volume(r, 'body_plate')
    solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'subtract', target: '@body_plate', tools: ['@arB'] },
    }, new Repository(), r.store,
    solvedArrays(['arA', 'array', outer], ['arB', 'array', inner]))

    // Both inner instances are cut; the outer source is not part of @arB. A
    // provenance inherited from the outer array would leave the inner copy in.
    expect(Object.keys(r.store).sort()).toEqual(['body_plate', 'body_spoke'])
    expect(volume(r, 'body_plate')).toBeCloseTo(plateBefore - 2 * 40 * 8 * 8, 3)
    r.scope.dispose()
  })

  it('a disjoint union folded into a copy does not join the array', () => {
    const r = rig()
    const plate = makeBoxAt(oc, r.scope, [-20, -10, -10], 340, 20, 20)
    seed(r, 'body_plate', 'plate', plate)
    seed(r, 'body_spoke', 'sp0', spokeShape(r))
    const ar1 = {
      source_body: '@body_spoke', mode: 'linear', operation: 'add', include_source: true,
      count_x: 2, pitch_x: 100, direction_x: [1, 0, 0],
    }
    solveArray(oc, r.scope, r.table, { id: 'ar1', array: ar1 }, new Repository(), r.store)

    // A bracket that does not touch the copy: the union is a two-solid compound,
    // so the bracket becomes a sibling OF the copy without being array material.
    seed(r, 'body_bracket', 'bracket', makeBoxAt(oc, r.scope, [200, -5, -5], 20, 10, 10))
    solveBoolean(oc, r.scope, r.table, {
      id: 'bool2', boolean: { operation: 'union', target: '@body_spoke_1', tools: ['@body_bracket'] },
    }, new Repository(), r.store)
    expect(r.store.body_spoke_1_1?.split_from).toEqual({ feature: 'bool2', body: 'body_spoke_1' })

    const plateBefore = volume(r, 'body_plate')
    solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'subtract', target: '@body_plate', tools: ['@ar1'] },
    }, new Repository(), r.store, solvedArrays(['ar1', 'array', ar1]))

    // Only the two spokes were cut. The bracket is its own body and stays whole;
    // an inherited provenance would have handed it to the array.
    expect(Object.keys(r.store).sort()).toEqual(['body_plate', 'body_spoke_1_1'])
    expect(volume(r, 'body_plate')).toBeCloseTo(plateBefore - 2 * 40 * 8 * 8, 3)
    expect(volume(r, 'body_spoke_1_1')).toBeCloseTo(20 * 10 * 10, 3)
    r.scope.dispose()
  })

  it('a hand list that names one copy still warns about the array it skipped', () => {
    const r = rig()
    seedWheel(r)
    solveCircularArray(oc, r.scope, r.table, { id: 'ca1', circular_array: CA1 }, new Repository(), r.store)
    expect(Object.keys(r.store)).toHaveLength(7)

    const res = solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'union', target: '@body_ex1', tools: ['@body_ex2_1'] },
    }, new Repository(), r.store, solvedArrays(['ca1', 'circular_array', CA1]))

    // The membership the warning counts is the same one the ref expands: six
    // instances, one used. Before the split siblings were counted the array had
    // one member and the hand list used zero of it, so nothing warned and the
    // din_rail trap (a count raised after the hand list) stayed silent.
    expect(res.solver_warning).toContain('array ca1 has 6 instances, the boolean uses 1')
    expect(res.solver_warning).toContain("name '@ca1' in tools")
    r.scope.dispose()
  })

  it('an operation: new array still resolves through created_by, unchanged', () => {
    const r = rig()
    const plate = makeBoxAt(oc, r.scope, [-20, -10, -10], 340, 20, 20)
    seed(r, 'body_plate', 'plate', plate)
    seed(r, 'body_spoke', 'sp0', spokeShape(r))
    const ar2 = {
      source_body: '@body_spoke', mode: 'linear', operation: 'new', include_source: true,
      count_x: 3, pitch_x: 100, direction_x: [1, 0, 0],
    }
    solveArray(oc, r.scope, r.table, { id: 'ar2', array: ar2 }, new Repository(), r.store)
    expect(Object.keys(r.store)).toHaveLength(4)

    const plateBefore = volume(r, 'body_plate')
    solveBoolean(oc, r.scope, r.table, {
      id: 'bool1', boolean: { operation: 'subtract', target: '@body_plate', tools: ['@ar2'] },
    }, new Repository(), r.store, solvedArrays(['ar2', 'array', ar2]))

    // Source instance plus the two minted copies: the ref already found all
    // three through the source body and created_by.
    expect(Object.keys(r.store)).toEqual(['body_plate'])
    expect(volume(r, 'body_plate')).toBeCloseTo(plateBefore - 3 * 40 * 8 * 8, 3)
    r.scope.dispose()
  })
})
