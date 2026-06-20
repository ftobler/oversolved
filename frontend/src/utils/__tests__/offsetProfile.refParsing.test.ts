import { describe, it, expect } from 'vitest'
import { parseVertexRef, lineVertexIndices, offsetCorners, lineIntersect } from '@/utils/geometry/offsetProfile'

// parseVertexRef accepts a resolved `{ entity, point }` dict as well as the
// `$<eid><key>` string. The existing suite covers the happy paths and the
// string rejections; these pin the object-form rejection branches and the
// non-endpoint case of lineVertexIndices.

describe('parseVertexRef object form', () => {
  it('accepts a valid {entity, point} dict for a known entity', () => {
    expect(parseVertexRef({ entity: 'aX', point: 'end' }, new Set(['aX']))).toEqual({
      entityId: 'aX',
      vertexKey: 'end',
    })
  })

  it('rejects an object whose entity is not a known id', () => {
    expect(parseVertexRef({ entity: 'aX', point: 'end' }, new Set(['other']))).toBeNull()
  })

  it('rejects an object missing a string point', () => {
    expect(parseVertexRef({ entity: 'aX' }, new Set(['aX']))).toBeNull()
    expect(parseVertexRef({ entity: 'aX', point: 42 }, new Set(['aX']))).toBeNull()
  })

  it('rejects an object whose entity is not a string', () => {
    expect(parseVertexRef({ entity: 99, point: 'end' }, new Set(['aX']))).toBeNull()
  })
})

describe('lineVertexIndices', () => {
  it('maps the two line endpoints into the [x0,y0,x1,y1] params', () => {
    expect(lineVertexIndices('start')).toEqual([0, 1])
    expect(lineVertexIndices('end')).toEqual([2, 3])
  })

  it('returns null for a key that is not a line endpoint', () => {
    expect(lineVertexIndices('center')).toBeNull()
    expect(lineVertexIndices('xy')).toBeNull()
    expect(lineVertexIndices('major1')).toBeNull()
  })
})

describe('offsetCorners within-entity coincidence', () => {
  it('does not treat a coincidence between two vertices of the same entity as a corner', () => {
    const constraints = [
      { kind: 'coincident', a: '$aXstart', b: '$aXend' },  // same entity, not a joint
    ]
    expect(offsetCorners(['aX', 'bY'], constraints)).toHaveLength(0)
  })
})

describe('lineIntersect degenerate input', () => {
  it('returns null when either line has zero length', () => {
    expect(lineIntersect([5, 5, 5, 5], [0, 0, 10, 0])).toBeNull()
    expect(lineIntersect([0, 0, 10, 0], [5, 5, 5, 5])).toBeNull()
  })
})
