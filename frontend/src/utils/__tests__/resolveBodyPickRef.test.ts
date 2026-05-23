import { describe, it, expect } from 'vitest'
import { resolveBodyPickRef, resolveBodyMergeRef, resolveAxisQuery } from '@/utils/resolveBodyPickRef'

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
})

describe('resolveBodyMergeRef', () => {
  it('converts body: prefix to @body_ ref', () => {
    expect(resolveBodyMergeRef('body:body_ex1')).toBe('@body_ex1')
  })

  it('converts @featureId to @body_featureId', () => {
    expect(resolveBodyMergeRef('@ex1')).toBe('@body_ex1')
  })

  it('converts @featureId/face/N to @body_featureId', () => {
    expect(resolveBodyMergeRef('@ex1/face/0')).toBe('@body_ex1')
  })

  it('coerces a ? ancestry query to @body_<first-segment> (unlike resolveBodyPickRef)', () => {
    // slice(1) strips the leading '?', then the first '/'-segment is taken;
    // this preserves the pre-existing editor behaviour verbatim.
    expect(resolveBodyMergeRef('?4;@ex1:solid')).toBe('@body_4;@ex1:solid')
  })

  it('passes @body_ refs through unchanged', () => {
    expect(resolveBodyMergeRef('@body_ex1')).toBe('@body_ex1')
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
