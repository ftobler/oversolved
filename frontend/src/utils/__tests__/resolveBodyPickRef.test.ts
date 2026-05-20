import { describe, it, expect } from 'vitest'
import { resolveBodyPickRef } from '@/utils/resolveBodyPickRef'

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
