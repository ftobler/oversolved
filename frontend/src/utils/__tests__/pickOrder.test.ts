/**
 * Build-order pick guard: a feature may only reference earlier features.
 */
import { describe, it, expect } from 'vitest'
import { isPickAllowed, selectionSourceFeatureIds } from '@/utils/query/pickOrder'
import { makeAncestryQuery } from '@/kernel/query'

// Mirrors the real stack: builtins first, then user features in build order.
const FEATURES = [
  { id: 'Origin' }, { id: 'Front' }, { id: 'Top' }, { id: 'Right' },
  { id: 'sk1' }, { id: 'ex1' }, { id: 'sk2' }, { id: 'ex2' }, { id: 'fil1' },
]
const KNOWN = new Set(FEATURES.map(f => f.id))

// ─── selectionSourceFeatureIds ───

describe('selectionSourceFeatureIds', () => {
  it('reads the owner out of prefixed selection ids', () => {
    expect(selectionSourceFeatureIds('entity:sk1:line1', KNOWN)).toEqual(['sk1'])
    expect(selectionSourceFeatureIds('vertex:sk1:line1:start', KNOWN)).toEqual(['sk1'])
    expect(selectionSourceFeatureIds('constraint:sk1:c3', KNOWN)).toEqual(['sk1'])
  })

  it('reads the owner out of a bare feature ref', () => {
    expect(selectionSourceFeatureIds('@sk1', KNOWN)).toEqual(['sk1'])
  })

  it('maps a body ref back to the feature that created the body', () => {
    expect(selectionSourceFeatureIds('@body_ex1', KNOWN)).toEqual(['ex1'])
  })

  it('reads the owner out of the topo fallback query', () => {
    expect(selectionSourceFeatureIds('@ex1/face/3', KNOWN)).toEqual(['ex1'])
    expect(selectionSourceFeatureIds('@ex1/edge/2', KNOWN)).toEqual(['ex1'])
  })

  it('reads created_by out of an ancestry query', () => {
    const q = makeAncestryQuery(['@gdf|0,0,5|0,0,1', '@ex1', '@body_ex1'], 'flatface')
    expect(selectionSourceFeatureIds(q, KNOWN)).toEqual(['ex1'])
  })

  it('recovers the feature id from a concatenated @<featureId><eid> token', () => {
    const q = makeAncestryQuery(['@ex1face0', '@ex1'], 'face')
    expect(selectionSourceFeatureIds(q, KNOWN)).toEqual(['ex1'])
  })

  it('prefers the longest matching feature id on a concatenated token', () => {
    const known = new Set(['ex1', 'ex12'])
    expect(selectionSourceFeatureIds('@ex12face0', known)).toEqual(['ex12'])
  })

  it('attributes nothing to descriptor tokens, classifiers or builtin planes', () => {
    expect(selectionSourceFeatureIds('@builtin_plane_front', KNOWN)).toEqual([])
    expect(selectionSourceFeatureIds('@gdf|0,0,5|0,0,1', KNOWN)).toEqual([])
    expect(selectionSourceFeatureIds(makeAncestryQuery(['@gface_ab12'], 'face'), KNOWN)).toEqual([])
  })

  it('collects every feature named by a face: selection, prefix and inner query', () => {
    const inner = makeAncestryQuery(['@gdf|0,0,5|0,0,1', '@ex2'], 'flatface')
    const ids = selectionSourceFeatureIds(`face:ex1:${inner}`, KNOWN)
    expect(ids.sort()).toEqual(['ex1', 'ex2'])
  })

  it('returns nothing for an unparseable ancestry query', () => {
    expect(selectionSourceFeatureIds('?zz', KNOWN)).toEqual([])
  })
})

// ─── isPickAllowed ───

describe('isPickAllowed', () => {
  it('allows a reference to an earlier feature', () => {
    expect(isPickAllowed('entity:sk1:line1', 'ex1', FEATURES)).toBe(true)
    expect(isPickAllowed('@body_ex1', 'ex2', FEATURES)).toBe(true)
    expect(isPickAllowed(makeAncestryQuery(['@gdf|0,0,5|0,0,1', '@ex1'], 'edge'), 'fil1', FEATURES)).toBe(true)
  })

  it('rejects a feature referencing its own output', () => {
    expect(isPickAllowed('@body_ex1', 'ex1', FEATURES)).toBe(false)
    expect(isPickAllowed('@ex1/face/3', 'ex1', FEATURES)).toBe(false)
    expect(isPickAllowed(makeAncestryQuery(['@gdf|0,0,5|0,0,1', '@ex1', '@body_ex1'], 'flatface'), 'ex1', FEATURES)).toBe(false)
  })

  it('rejects a feature referencing a later feature', () => {
    expect(isPickAllowed('@body_ex2', 'ex1', FEATURES)).toBe(false)
    expect(isPickAllowed('entity:sk2:line1', 'ex1', FEATURES)).toBe(false)
    expect(isPickAllowed(makeAncestryQuery(['@gdf|0,0,5|0,0,1', '@fil1'], 'edge'), 'ex2', FEATURES)).toBe(false)
  })

  it('rejects when any token of a mixed ancestry names the host', () => {
    const inner = makeAncestryQuery(['@gdf|0,0,5|0,0,1', '@ex2'], 'flatface')
    expect(isPickAllowed(`face:ex1:${inner}`, 'ex2', FEATURES)).toBe(false)
  })

  it('allows builtin planes for any host', () => {
    expect(isPickAllowed('@builtin_plane_front', 'sk1', FEATURES)).toBe(true)
    expect(isPickAllowed('@Front', 'sk1', FEATURES)).toBe(true)
  })

  it('fails open when the host is not in the feature list', () => {
    expect(isPickAllowed('@body_ex2', 'not_yet_rendered', FEATURES)).toBe(true)
  })

  it('fails open when the feature list is empty', () => {
    expect(isPickAllowed('@body_ex1', 'ex1', [])).toBe(true)
  })
})
