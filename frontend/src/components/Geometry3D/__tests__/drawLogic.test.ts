import { describe, it, expect } from 'vitest'
import { resolveSnapPoint, computeDrawClick } from '../drawLogic'
import type { DrawSnapState } from '../drawLogic'

const FEATURE = 'S1'
let idCounter = 0
const newId = () => `E${++idCounter}`

const emptySnap = (): DrawSnapState => ({
  hoveredVertexId: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  hoveredEntityId: null,
  drawSnapVertexId: null,
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
  alignmentSnapVertexId: null,
})

describe('resolveSnapPoint', () => {
  it('returns raw point when no snap active', () => {
    expect(resolveSnapPoint([3, 4], emptySnap())).toEqual([3, 4])
  })

  it('kinda_horizontal alignment snap pins y from anchor', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [100, 50]
    snap.alignmentSnapKind = 'kinda_horizontal'
    // x comes from raw, y from anchor
    expect(resolveSnapPoint([30, 99], snap)).toEqual([30, 50])
  })

  it('kinda_vertical alignment snap pins x from anchor', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [100, 50]
    snap.alignmentSnapKind = 'kinda_vertical'
    // x from anchor, y from raw
    expect(resolveSnapPoint([30, 99], snap)).toEqual([100, 99])
  })

  it('alignment snap wins over vertex hover', () => {
    const snap = emptySnap()
    snap.hoveredVertexPosition = [10, 20]
    snap.alignmentSnapPoint = [100, 50]
    snap.alignmentSnapKind = 'kinda_horizontal'
    const result = resolveSnapPoint([5, 99], snap)
    // alignment snap takes priority: x from raw, y from alignment anchor
    expect(result).toEqual([5, 50])
  })
})

describe('computeDrawClick - point tool', () => {
  it('emits add_entity immediately with clearTool=true', () => {
    const result = computeDrawClick('point', [], [3, 4], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].kind).toBe('point')
      expect(result.mutations[0].params).toEqual([3, 4])
    }
    expect(result.clearTool).toBe(true)
    expect(result.nextDrawPoints).toBeNull()
  })
})

describe('computeDrawClick - line tool', () => {
  it('first click accumulates point, no mutations', () => {
    const result = computeDrawClick('line', [], [1, 2], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[1, 2]])
    expect(result.clearTool).toBe(false)
  })

  it('first click with vertex snap records drawSnap', () => {
    const snap = emptySnap()
    snap.hoveredVertexId = 'vertex:S1:L1:end'
    snap.hoveredVertexPosition = [5, 0]
    const result = computeDrawClick('line', [], [5, 0], snap, FEATURE, newId)
    expect(result.nextDrawSnap?.vertexId).toBe('vertex:S1:L1:end')
  })

  it('second click with no snap emits add_entity and clearTool', () => {
    const result = computeDrawClick('line', [[0, 0]], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].kind).toBe('line')
      expect(result.mutations[0].params).toEqual([0, 0, 5, 5])
    }
    expect(result.clearTool).toBe(true)
  })

  it('second click with start vertex snap emits add_entity_with_constraint', () => {
    const snap = emptySnap()
    snap.drawSnapVertexId = 'vertex:S1:L1:end'
    const result = computeDrawClick('line', [[0, 0]], [5, 5], snap, FEATURE, newId)
    expect(result.mutations[0].type).toBe('add_entity_with_constraint')
    if (result.mutations[0].type === 'add_entity_with_constraint') {
      expect(result.mutations[0].vertexKey).toBe('start')
      expect(result.mutations[0].snapVertexId).toBe('vertex:S1:L1:end')
    }
  })

  it('second click with end vertex snap emits entity + constraint mutations', () => {
    const snap = emptySnap()
    snap.hoveredVertexId = 'vertex:S1:L2:start'
    snap.hoveredVertexPosition = [10, 0]
    snap.hoveredSnapKind = 'vertex'
    const result = computeDrawClick('line', [[0, 0]], [10, 0], snap, FEATURE, newId)
    expect(result.mutations.length).toBeGreaterThanOrEqual(2)
    const kinds = result.mutations.map(m => m.type)
    expect(kinds).toContain('add_entity')
    expect(kinds).toContain('add_constraint')
  })


})

describe('computeDrawClick - circle tool', () => {
  it('first click records center, no mutations', () => {
    const result = computeDrawClick('circle', [], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[5, 5]])
    expect(result.clearTool).toBe(false)
  })

  it('second click emits add_entity circle with correct radius', () => {
    const result = computeDrawClick('circle', [[0, 0]], [3, 4], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].kind).toBe('circle')
      // radius should be hypot(3,4) = 5
      expect(result.mutations[0].params[2]).toBeCloseTo(5)
    }
    expect(result.clearTool).toBe(true)
  })

  it('second click with zero radius returns no mutation', () => {
    const result = computeDrawClick('circle', [[5, 5]], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.clearTool).toBe(false)
  })
})

describe('computeDrawClick - arc tool', () => {
  it('first click records start, no mutations', () => {
    const result = computeDrawClick('arc', [], [0, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[0, 0]])
  })

  it('second click records end, no mutations yet', () => {
    const result = computeDrawClick('arc', [[0, 0]], [10, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[0, 0], [10, 0]])
  })

  it('third click emits add_entity arc', () => {
    const result = computeDrawClick('arc', [[0, 0], [10, 0]], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].kind).toBe('arc')
      expect(result.mutations[0].params).toHaveLength(5)
    }
    expect(result.clearTool).toBe(true)
  })

  it('three collinear points returns no mutation', () => {
    const result = computeDrawClick('arc', [[0, 0], [5, 0]], [10, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.clearTool).toBe(false)
  })
})

describe('computeDrawClick - rect tool', () => {
  it('first click records corner, no mutations', () => {
    const result = computeDrawClick('rect', [], [0, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[0, 0]])
  })

  it('second click emits add_rect', () => {
    const result = computeDrawClick('rect', [[0, 0]], [5, 3], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_rect')
    if (result.mutations[0].type === 'add_rect') {
      expect(result.mutations[0].p0).toEqual([0, 0])
      expect(result.mutations[0].p1).toEqual([5, 3])
    }
    expect(result.clearTool).toBe(true)
  })
})

describe('computeDrawClick - center_rect tool', () => {
  it('first click records center, no mutations', () => {
    const result = computeDrawClick('center_rect', [], [2, 2], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[2, 2]])
  })

  it('second click emits add_center_rect', () => {
    const result = computeDrawClick('center_rect', [[0, 0]], [3, 3], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_center_rect')
    if (result.mutations[0].type === 'add_center_rect') {
      expect(result.mutations[0].center).toEqual([0, 0])
      expect(result.mutations[0].corner).toEqual([3, 3])
    }
    expect(result.clearTool).toBe(true)
  })
})

describe('computeDrawClick - project tool', () => {
  it('returns nothing when no entity is hovered', () => {
    const result = computeDrawClick('project', [], [0, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.clearTool).toBe(false)
  })

  it('returns nothing when hovered entity is in same feature', () => {
    const snap = emptySnap()
    snap.hoveredEntityId = `entity:${FEATURE}:L1`
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
  })

  it('emits add_projected_entity for entity from another feature', () => {
    const snap = emptySnap()
    snap.hoveredEntityId = 'entity:S2:L1'
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].source).toBe('@S2/L1')
    }
    expect(result.clearTool).toBe(true)
  })
})
