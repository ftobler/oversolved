import { describe, it, expect } from 'vitest'
import { collectCoincidentVertexIds } from '../dragLogic'

describe('collectCoincidentVertexIds', () => {
  const fid = 'feat1'

  it('returns just the seed vertex when there are no coincident constraints', () => {
    const ids = collectCoincidentVertexIds([], fid, 'lineA', 'end')
    expect([...ids]).toEqual(['vertex:feat1:lineA:end'])
  })

  it('includes a direct coincident partner', () => {
    const constraints = [
      { kind: 'coincident', a: '$lineAend', b: '$lineBstart' },
    ]
    const ids = collectCoincidentVertexIds(constraints, fid, 'lineA', 'end')
    expect(ids.has('vertex:feat1:lineA:end')).toBe(true)
    expect(ids.has('vertex:feat1:lineB:start')).toBe(true)
    expect(ids.size).toBe(2)
  })

  it('follows a transitive chain of coincidences', () => {
    const constraints = [
      { kind: 'coincident', a: '$lineAend', b: '$lineBstart' },
      { kind: 'coincident', a: '$lineBstart', b: '$lineCcenter' },
    ]
    const ids = collectCoincidentVertexIds(constraints, fid, 'lineA', 'end')
    expect(ids.has('vertex:feat1:lineC:center')).toBe(true)
    expect(ids.size).toBe(3)
  })

  it('ignores non-coincident constraints and builtin/non-local refs', () => {
    const constraints = [
      { kind: 'coincident', a: '$lineAstart', b: '@builtin_origin' },
      { kind: 'horizontal', a: '$lineAend', b: '$lineBstart' },
    ]
    const ids = collectCoincidentVertexIds(constraints, fid, 'lineA', 'start')
    // builtin ref is not a local vertex, horizontal is not coincident
    expect([...ids]).toEqual(['vertex:feat1:lineA:start'])
  })

  it('does not loop forever on mutual references', () => {
    const constraints = [
      { kind: 'coincident', a: '$lineAend', b: '$lineBstart' },
      { kind: 'coincident', a: '$lineBstart', b: '$lineAend' },
    ]
    const ids = collectCoincidentVertexIds(constraints, fid, 'lineA', 'end')
    expect(ids.size).toBe(2)
  })
})
