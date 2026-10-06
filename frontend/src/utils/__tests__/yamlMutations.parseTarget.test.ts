import { describe, it, expect } from 'vitest'
import { parseTarget } from '@/utils/yamlMutations'

// parseTarget for @featureId feature-plane references
// A bare @<featureId> (no element suffix) is a feature-plane reference.
// parseTarget must pass it through unchanged so the solver can resolve
// it to the feature's defining plane.
describe('parseTarget for feature-plane references', () => {
  it('passes through @featureId unchanged (sketch feature-plane ref)', () => {
    expect(parseTarget('@sketch1', 'sketch2')).toBe('@sketch1')
  })

  it('passes through @featureId unchanged even from same feature context', () => {
    expect(parseTarget('@sketch1', 'sketch1')).toBe('@sketch1')
  })

  it('passes through builtin plane references unchanged', () => {
    expect(parseTarget('@builtin_plane_front', 'sketch1')).toBe('@builtin_plane_front')
    expect(parseTarget('@builtin_plane_top', 'sketch1')).toBe('@builtin_plane_top')
    expect(parseTarget('@builtin_plane_right', 'sketch1')).toBe('@builtin_plane_right')
  })

  it('passes through @extrude feature-plane ref unchanged', () => {
    // @extrude1 will resolve to extrude1's origin/top plane (resolved by the kernel).
    // The frontend must pass it through without modification.
    expect(parseTarget('@extrude1', 'sketch2')).toBe('@extrude1')
  })
})

// parseTarget for face: IDs
describe('parseTarget for face IDs', () => {
  it('returns raw query for face from different feature', () => {
    expect(parseTarget('face:sketch0:?3;@sketch0abc', 'sketch1')).toBe('?3;@sketch0abc')
  })

  it('returns raw query for face from same feature', () => {
    expect(parseTarget('face:sketch1:?3;@sketch1abc', 'sketch1')).toBe('?3;@sketch1abc')
  })

  it('preserves colon in type restriction suffix', () => {
    expect(parseTarget('face:sketch0:?9,9;@sketch0la@sketch0lb:face', 'sketch1')).toBe('?9,9;@sketch0la@sketch0lb:face')
  })
})

// parseTarget for edge: IDs. Before the unified wrapper stripper an edge:
// selection became the dead ref `$edge:sketch0:?...`; it must now yield its
// inner query like a face: ID does.
describe('parseTarget for edge IDs', () => {
  it('returns raw query for edge from a different feature', () => {
    expect(parseTarget('edge:sketch0:?3;@sketch0abc', 'sketch1')).toBe('?3;@sketch0abc')
  })

  it('returns raw query for edge from the same feature', () => {
    expect(parseTarget('edge:sketch1:?3;@sketch1abc', 'sketch1')).toBe('?3;@sketch1abc')
  })

  it('preserves colon in the edge type restriction suffix', () => {
    expect(parseTarget('edge:sketch0:?9,9;@sketch0la@sketch0lb:straightedge', 'sketch1')).toBe('?9,9;@sketch0la@sketch0lb:straightedge')
  })
})
