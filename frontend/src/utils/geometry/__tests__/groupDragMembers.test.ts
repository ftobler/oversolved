// The group-drag member list: which selected elements a press on one of them
// moves. Pure, so the rule is testable without a viewport or the solver.
import { describe, it, expect } from 'vitest'
import { groupDragMembers } from '@/utils/geometry/groupDragMembers'

const edgeStart = (entityId: string) => ({ type: 'edge' as const, entityId, vertexKey: '' })
const vertexStart = (entityId: string, vertexKey: string) =>
  ({ type: 'vertex' as const, entityId, vertexKey })

describe('groupDragMembers', () => {
  it('moves every selected line whole when the press is on one of them', () => {
    const selection = new Set(['entity:sk1:l1', 'entity:sk1:l2'])
    expect(groupDragMembers(selection, 'sk1', edgeStart('l1'))).toEqual([
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'edge' },
    ])
  })

  it('gives no group when the press is on an unselected line', () => {
    const selection = new Set(['entity:sk1:l2'])
    expect(groupDragMembers(selection, 'sk1', edgeStart('l1'))).toBeUndefined()
  })

  it('drops a selected vertex that its whole selected entity subsumes', () => {
    const selection = new Set([
      'entity:sk1:l1',
      'vertex:sk1:l1:end',
      'entity:sk1:l2',
    ])
    // The corner of l1 is already in the group through l1; listing it again
    // would anchor and translate that pair twice.
    expect(groupDragMembers(selection, 'sk1', edgeStart('l1'))).toEqual([
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'edge' },
    ])
  })

  it('gives no group for one selected vertex, pressed on that vertex', () => {
    const selection = new Set(['vertex:sk1:l1:start'])
    expect(groupDragMembers(selection, 'sk1', vertexStart('l1', 'start'))).toBeUndefined()
  })

  it('treats a selected vertex of an unselected entity as a point member', () => {
    const selection = new Set([
      'entity:sk1:l1',
      'vertex:sk1:l2:end',
      'vertex:sk1:l2:start',
    ])
    expect(groupDragMembers(selection, 'sk1', vertexStart('l2', 'start'))).toEqual([
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'end' },
      { entityId: 'l2', vertexKey: 'start' },
    ])
  })

  it('lets a press on a selected entity include its selected vertices', () => {
    // The press is on l2's body, which is not selected; but l1 is selected, so
    // the corner of l2 is not part of the pressed element and the press must
    // stay a single drag of l2.
    const selection = new Set(['entity:sk1:l1', 'vertex:sk1:l2:start'])
    expect(groupDragMembers(selection, 'sk1', edgeStart('l2'))).toBeUndefined()
  })

  it('ignores constraint ids, other sketches and body picks', () => {
    const selection = new Set([
      'constraint:sk1:c1',
      'entity:sk2:x1',
      'vertex:sk2:x1:start',
      '?2;@body_1',
      'entity:sk1:l1',
      'entity:sk1:l2',
    ])
    expect(groupDragMembers(selection, 'sk1', edgeStart('l1'))).toEqual([
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'edge' },
    ])
  })

  it('is empty for an empty selection', () => {
    expect(groupDragMembers(new Set(), 'sk1', edgeStart('l1'))).toBeUndefined()
  })
})
