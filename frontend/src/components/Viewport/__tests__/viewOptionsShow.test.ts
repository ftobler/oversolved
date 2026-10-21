// The Show rows describe document visibility, so their ids and check state must
// match what the viewport draws and what the tree's eye writes. The three
// groups are deliberately disjoint: planes never include the origin marker, and
// origin is the marker alone.
import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { showGroupIds, showGroupState, showGroupStates } from '@/components/Viewport/viewOptionsShow'

const features = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
  { id: 'ex1', kind: 'plane', label: 'My plane' },
  { id: 'sk1', kind: 'sketch' },
  { id: 'sk2', kind: 'sketch' },
  { id: 'bx1', kind: 'extrude' },
] as unknown as PartFeature[]

describe('view options Show groups', () => {
  it('splits the document into planes, sketches and the origin marker', () => {
    expect(showGroupIds(features, 'planes')).toEqual(['Top', 'Front', 'Right', 'ex1'])
    expect(showGroupIds(features, 'sketches')).toEqual(['sk1', 'sk2'])
    expect(showGroupIds(features, 'origin')).toEqual(['Origin'])
  })

  it('reads a group as shown only when every member is drawn', () => {
    const all = new Set(['Top', 'Front', 'Right', 'ex1', 'sk1', 'sk2', 'Origin'])
    expect(showGroupStates(features, all).planes.visible).toBe(true)

    const oneHidden = new Set(['Top', 'Front', 'ex1', 'sk1', 'sk2', 'Origin'])
    expect(showGroupStates(features, oneHidden).planes.visible).toBe(false)
    expect(showGroupStates(features, oneHidden).sketches.visible).toBe(true)
  })

  it('disables a group with no members', () => {
    expect(showGroupState([], new Set(), 'sketches')).toEqual({ visible: false, disabled: true })
    expect(showGroupState(features, new Set(), 'origin')).toEqual({ visible: false, disabled: false })
  })
})
