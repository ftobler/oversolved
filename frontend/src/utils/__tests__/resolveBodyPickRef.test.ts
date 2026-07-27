import { describe, it, expect } from 'vitest'
import { resolveBodyPickRef, resolveAxisQuery } from '@/utils/query/resolveBodyPickRef'

describe('resolveBodyPickRef', () => {
  it('converts body: prefix to @body_ ref', () => {
    expect(resolveBodyPickRef('body:body_ex1')).toBe('@body_ex1')
  })

  it('converts @featureId to @body_featureId', () => {
    expect(resolveBodyPickRef('@ex1')).toBe('@body_ex1')
  })

  it('converts @featureId/face/N to @body_featureId', () => {
    expect(resolveBodyPickRef('@ex1/face/0')).toBe('@body_ex1')
  })

  it('passes @body_ refs through unchanged', () => {
    expect(resolveBodyPickRef('@body_ex1')).toBe('@body_ex1')
  })

  it('passes ? ancestry queries through unchanged for backend resolution', () => {
    expect(resolveBodyPickRef('?4;@ex1:solid')).toBe('?4;@ex1:solid')
  })

  it('extracts inner query from face: selection ID', () => {
    expect(resolveBodyPickRef('face:ex1:?9,9;@ex1face0@ex1face1:face'))
      .toBe('?9,9;@ex1face0@ex1face1:face')
  })

  it('extracts inner query when face inner query contains colons', () => {
    expect(resolveBodyPickRef('face:ex1:?4;@ex1:face')).toBe('?4;@ex1:face')
  })

  // A merge target is written by the same transform as a source_body pick. The
  // merge-target variant used to mint '@body_' + everything before the first
  // slash of a '?' query, i.e. the literal id '@body_4;@ex1:solid', and persist
  // it; nothing could ever resolve that. Body-exact refs must survive verbatim.
  it('never mints a "@body_" id out of a ? query', () => {
    for (const q of ['?4;@ex1:solid', '?9,9;@ex1face0@ex1face1:face']) {
      expect(resolveBodyPickRef(q)).toBe(q)
    }
  })

  // The render fallback now names the BODY, so a pick on a split sibling
  // arrives as '@body_ex1_1/...' and must keep its sibling suffix.
  it('keeps a split sibling id intact', () => {
    expect(resolveBodyPickRef('@body_ex1_1/face/0')).toBe('@body_ex1_1')
    expect(resolveBodyPickRef('body:body_ex1_1')).toBe('@body_ex1_1')
  })
})

describe('resolveAxisQuery', () => {
  it('extracts inner query from a face: selection ID', () => {
    expect(resolveAxisQuery('face:ex1:?4;@ex1:face')).toBe('?4;@ex1:face')
  })

  it('extracts inner query from an edge: selection ID', () => {
    expect(resolveAxisQuery('edge:ex1:?4;@ex1:edge')).toBe('?4;@ex1:edge')
  })

  it('converts an entity: selection ID to an absolute ref', () => {
    expect(resolveAxisQuery('entity:sk1:line1')).toBe('@sk1/line1')
  })

  it('passes other strings through unchanged', () => {
    expect(resolveAxisQuery('@builtin_plane_front')).toBe('@builtin_plane_front')
  })
})
