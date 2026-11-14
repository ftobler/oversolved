// The Group command's selection reading: vertex markers next to their own
// entity are duplicates, uncovered vertices are point members, a Point's xy is
// its entity, and the origin/projected geometry never joins a group.
import { describe, it, expect } from 'vitest'
import { groupMembersFromSelection } from '@/utils/groupMembers'

const kinds = {
  'entity:S1:C1': 'circle',
  'entity:S1:L1': 'line',
  'entity:S1:L2': 'line',
  'entity:S1:P1': 'point',
  'entity:S1:SP': 'spline',
}

function read(selection: string[], projected: string[] = []) {
  return groupMembersFromSelection(selection, 'S1', kinds, new Set(projected))
}

describe('groupMembersFromSelection', () => {
  it('drops a centre marker covered by its own circle', () => {
    expect(read(['entity:S1:C1', 'vertex:S1:C1:center'])).toEqual({
      targets: ['entity:S1:C1'],
    })
  })

  it('drops every endpoint covered by the selected lines', () => {
    expect(read([
      'entity:S1:L1', 'entity:S1:L2',
      'vertex:S1:L1:start', 'vertex:S1:L1:end',
      'vertex:S1:L2:start', 'vertex:S1:L2:end',
    ])).toEqual({ targets: ['entity:S1:L1', 'entity:S1:L2'] })
  })

  it('keeps uncovered control points as point members', () => {
    expect(read(['vertex:S1:SP:c1', 'vertex:S1:SP:c2'])).toEqual({
      targets: ['vertex:S1:SP:c1', 'vertex:S1:SP:c2'],
    })
  })

  it('keeps a line whole and only the orphan endpoint of another line', () => {
    expect(read(['entity:S1:L1', 'vertex:S1:L2:end'])).toEqual({
      targets: ['entity:S1:L1', 'vertex:S1:L2:end'],
    })
  })

  it('drops a marker even when its entity is picked after it', () => {
    expect(read(['vertex:S1:L1:start', 'entity:S1:L1'])).toEqual({
      targets: ['entity:S1:L1'],
    })
  })

  it('keeps the click order of the members', () => {
    expect(read(['vertex:S1:L2:end', 'entity:S1:L1'])).toEqual({
      targets: ['vertex:S1:L2:end', 'entity:S1:L1'],
    })
  })

  it('drops a repeated point pick', () => {
    expect(read(['vertex:S1:SP:c1', 'vertex:S1:SP:c1', 'entity:S1:L1'])).toEqual({
      targets: ['vertex:S1:SP:c1', 'entity:S1:L1'],
    })
  })

  it('promotes a lone Point to its whole entity', () => {
    expect(read(['vertex:S1:P1:xy'])).toEqual({ targets: ['entity:S1:P1'] })
  })

  it('stores a Point and a line both whole', () => {
    expect(read(['vertex:S1:P1:xy', 'entity:S1:L2'])).toEqual({
      targets: ['entity:S1:P1', 'entity:S1:L2'],
    })
  })

  it('collapses a Point that is picked both whole and by its marker', () => {
    expect(read(['entity:S1:P1', 'vertex:S1:P1:xy'])).toEqual({
      targets: ['entity:S1:P1'],
    })
  })

  it('refuses a single uncovered point with the two-point sentence', () => {
    expect(read(['vertex:S1:SP:c1'])).toEqual({
      reason: 'Group needs at least two points, or one whole entity.',
    })
  })

  it('skips the origin in a mixed selection', () => {
    expect(read(['@builtin_origin', 'entity:S1:L1'])).toEqual({
      targets: ['entity:S1:L1'],
    })
    expect(read(['@builtin_origin'])).toEqual({
      reason: 'Group cannot hold the origin; select an authored entity or point.',
    })
  })

  it('skips projected geometry, and refuses a selection that is only that', () => {
    expect(read(['entity:S1:C1', 'entity:S1:L1'], ['C1'])).toEqual({
      targets: ['entity:S1:L1'],
    })
    expect(read(['entity:S1:C1'], ['C1'])).toEqual({
      reason: 'Group cannot hold projected geometry; select an authored entity or point.',
    })
  })

  it('skips dock and isect handles and non-geometry picks', () => {
    expect(read([
      'dock:constraint:1', 'isect:feature:1', 'constraint:S1:C2', 'entity:S1:L1',
    ])).toEqual({ targets: ['entity:S1:L1'] })
    expect(read(['dock:constraint:1', 'constraint:S1:C2'])).toEqual({ targets: [] })
  })

  it('refuses a foreign whole-entity pick instead of relying on the applier', () => {
    // The applier projects a foreign ref into this sketch before the shape
    // rule runs, and groupProblem skips an id not yet in entityIds, so the
    // member would be stored and the loader would refuse the whole document.
    expect(read(['entity:Other:L9', 'entity:S1:L1'])).toEqual({
      reason: "Group cannot hold geometry from another sketch; select this sketch's entities and points.",
    })
  })

  it('refuses a foreign pick even when its id matches a local marker', () => {
    expect(read(['vertex:S1:L1:start', 'entity:Other:L1'])).toEqual({
      reason: "Group cannot hold geometry from another sketch; select this sketch's entities and points.",
    })
  })

  it('does not promote a non-xy key on a Point to the whole entity', () => {
    // A hand-built `center` on a Point has no such point; it stays a point
    // member so the shape rule and the loader can refuse it.
    expect(read(['vertex:S1:P1:center', 'entity:S1:L1'])).toEqual({
      targets: ['vertex:S1:P1:center', 'entity:S1:L1'],
    })
  })
})
