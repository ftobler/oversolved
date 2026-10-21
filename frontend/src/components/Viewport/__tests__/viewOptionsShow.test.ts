// The Show rows describe document visibility, so their ids and check state must
// match what the viewport draws and what the tree's eye writes. The three
// groups are deliberately disjoint: planes never include the origin marker, and
// origin is the marker alone.
import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { showGroupIds, showGroupState, showGroupStates, showGroupToggleMutations } from '@/components/Viewport/viewOptionsShow'

const features = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
  { id: 'ex1', kind: 'plane', label: 'My plane' },
  { id: 'sk1', kind: 'sketch' },
  { id: 'sk2', kind: 'sketch' },
  { id: 'helix1', kind: 'helix' },
  { id: 'bx1', kind: 'extrude' },
] as unknown as PartFeature[]

describe('view options Show groups', () => {
  it('splits the document into planes, sketches and the origin marker', () => {
    expect(showGroupIds(features, 'planes')).toEqual(['Top', 'Front', 'Right', 'ex1'])
    // A helix is sketch-class reference geometry, like the tree eye and the `y`
    // toggle treat it.
    expect(showGroupIds(features, 'sketches')).toEqual(['sk1', 'sk2', 'helix1'])
    expect(showGroupIds(features, 'origin')).toEqual(['Origin'])
  })

  it('reads a group as shown only when every member is drawn', () => {
    const all = new Set(['Top', 'Front', 'Right', 'ex1', 'sk1', 'sk2', 'helix1', 'Origin'])
    expect(showGroupStates(features, all).planes.visible).toBe(true)

    const oneHidden = new Set(['Top', 'Front', 'ex1', 'sk1', 'sk2', 'helix1', 'Origin'])
    expect(showGroupStates(features, oneHidden).planes.visible).toBe(false)
    expect(showGroupStates(features, oneHidden).sketches.visible).toBe(true)
  })

  it('disables a group with no members', () => {
    expect(showGroupState([], new Set(), 'sketches')).toEqual({ visible: false, disabled: true })
    expect(showGroupState(features, new Set(), 'origin')).toEqual({ visible: false, disabled: false })
  })

  it('an unchecked row shows every member instead of hiding the rest', () => {
    // One plane hidden by the tree eye: the row reads unchecked, and its click
    // must write visible=true for the whole group. The keyboard toggle's
    // any-visible-hides-all would hide the other two planes instead.
    const partlyHidden = new Set(['Top', 'Front', 'sk1', 'sk2', 'helix1', 'Origin'])
    expect(showGroupToggleMutations(features, partlyHidden, 'planes')).toEqual([
      { type: 'set_feature_visibility', featureId: 'Top', visible: true },
      { type: 'set_feature_visibility', featureId: 'Front', visible: true },
      { type: 'set_feature_visibility', featureId: 'Right', visible: true },
      { type: 'set_feature_visibility', featureId: 'ex1', visible: true },
    ])
  })

  it('a checked row hides every member', () => {
    const all = new Set(['Top', 'Front', 'Right', 'ex1', 'sk1', 'sk2', 'helix1', 'Origin'])
    expect(showGroupToggleMutations(features, all, 'sketches')).toEqual([
      { type: 'set_feature_visibility', featureId: 'sk1', visible: false },
      { type: 'set_feature_visibility', featureId: 'sk2', visible: false },
      { type: 'set_feature_visibility', featureId: 'helix1', visible: false },
    ])
  })
})
