// Pure (no OCC) tests for edge-profile ref classification (extrude-brep-profile).

import { describe, it, expect } from 'vitest'
import { isEdgeProfileRef } from './edgeProfile'
import { makeAncestryQuery, ref } from '../query'

describe('isEdgeProfileRef', () => {
  it('detects ancestry edge / straightedge type restrictions', () => {
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gedge_abc'), ref('ex1')], 'edge'))).toBe(true)
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gedge_abc'), ref('ex1')], 'straightedge'))).toBe(true)
  })

  it('detects the ?body:edge:N index alias', () => {
    expect(isEdgeProfileRef('?body_ex1:edge:0')).toBe(true)
    expect(isEdgeProfileRef('?body_ex1:straightedge:3')).toBe(true)
  })

  it('rejects sketch and face profile refs', () => {
    expect(isEdgeProfileRef('$sk1')).toBe(false)
    expect(isEdgeProfileRef('@ex1/top_face')).toBe(false)
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gface_abc'), ref('ex1')], 'flatface'))).toBe(false)
    expect(isEdgeProfileRef(makeAncestryQuery([ref('gface_abc'), ref('ex1')], 'face'))).toBe(false)
  })
})
