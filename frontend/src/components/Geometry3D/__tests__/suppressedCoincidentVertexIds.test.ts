import { describe, it, expect } from 'vitest'
import { suppressedCoincidentVertexIds } from '../dragLogic'

describe('suppressedCoincidentVertexIds', () => {
  const fid = 'feat1'

  it('suppresses nothing when there are no coincident constraints', () => {
    expect(suppressedCoincidentVertexIds([], fid).size).toBe(0)
    const constraints = [{ kind: 'horizontal', a: '$lineAend', b: '$lineBstart' }]
    expect(suppressedCoincidentVertexIds(constraints, fid).size).toBe(0)
  })

  it('keeps the smaller composite id and suppresses the partner', () => {
    const constraints = [{ kind: 'coincident', a: '$lineBstart', b: '$lineAend' }]
    const s = suppressedCoincidentVertexIds(constraints, fid)
    // lineA:end < lineB:start lexicographically, so lineA:end is the kept leader.
    expect(s.has('vertex:feat1:lineB:start')).toBe(true)
    expect(s.has('vertex:feat1:lineA:end')).toBe(false)
    expect(s.size).toBe(1)
  })

  it('collapses a transitive chain to a single leader', () => {
    const constraints = [
      { kind: 'coincident', a: '$lineAend', b: '$lineBstart' },
      { kind: 'coincident', a: '$lineBstart', b: '$lineCcenter' },
    ]
    const s = suppressedCoincidentVertexIds(constraints, fid)
    // Leader is the smallest id (lineA:end); the other two are hidden.
    expect(s.has('vertex:feat1:lineA:end')).toBe(false)
    expect(s.has('vertex:feat1:lineB:start')).toBe(true)
    expect(s.has('vertex:feat1:lineC:center')).toBe(true)
    expect(s.size).toBe(2)
  })

  it('is order independent (leader is always the smallest id)', () => {
    const a = suppressedCoincidentVertexIds(
      [{ kind: 'coincident', a: '$lineAend', b: '$lineBstart' }], fid)
    const b = suppressedCoincidentVertexIds(
      [{ kind: 'coincident', a: '$lineBstart', b: '$lineAend' }], fid)
    expect([...a].sort()).toEqual([...b].sort())
  })

  it('does not merge a point that is only coincident with a builtin (non-local) ref', () => {
    // Overlap-without-a-two-point-constraint must stay two points.
    const constraints = [{ kind: 'coincident', a: '$lineAstart', b: '@builtin_origin' }]
    expect(suppressedCoincidentVertexIds(constraints, fid).size).toBe(0)
  })

  it('keeps separate clusters separate', () => {
    const constraints = [
      { kind: 'coincident', a: '$lineAend', b: '$lineBstart' },
      { kind: 'coincident', a: '$lineCend', b: '$lineDstart' },
    ]
    const s = suppressedCoincidentVertexIds(constraints, fid)
    expect(s.has('vertex:feat1:lineB:start')).toBe(true)
    expect(s.has('vertex:feat1:lineD:start')).toBe(true)
    expect(s.size).toBe(2)
  })
})
