import { describe, it, expect } from 'vitest'
import {
  isProjectedEntity,
  isProjectedLine,
  isProjectedCircle,
  isProjectedArc,
  isProjectedPoint,
} from '../../types/cad'
import type { Entity, LineSegment, Circle, Arc, PointEntity } from '../../types/cad'
import { unflattenGeometry } from '../../utils/geometryMapping'

// Regular (non-projected) entities for negative tests
const regularLine: LineSegment = { start: [0, 0], end: [1, 0] }
const regularCircle: Circle = { center: [0, 0], radius: 1 }
const regularArc: Arc = { center: [0, 0], radius: 1, angle_start: 0, angle_end: 90, start: [1, 0], end: [0, 1] }
const regularPoint: PointEntity = { x: 0, y: 0 }

describe('isProjectedEntity', () => {
  it('returns false for a regular line', () => {
    expect(isProjectedEntity(regularLine)).toBe(false)
  })

  it('returns false for a regular circle', () => {
    expect(isProjectedEntity(regularCircle)).toBe(false)
  })

  it('returns false for a regular arc', () => {
    expect(isProjectedEntity(regularArc)).toBe(false)
  })

  it('returns false for a regular point', () => {
    expect(isProjectedEntity(regularPoint)).toBe(false)
  })

  it('returns true for a projected line', () => {
    const e: Entity = { start: [0, 0], end: [1, 0], projected: true, source: '@sketch0/line1' }
    expect(isProjectedEntity(e)).toBe(true)
  })

  it('returns true for a projected circle', () => {
    const e: Entity = { center: [0, 0], radius: 2, projected: true, source: '@sketch0/circle1' }
    expect(isProjectedEntity(e)).toBe(true)
  })

  it('returns true for a projected arc', () => {
    const e: Entity = {
      center: [0, 0], radius: 1, angle_start: 0, angle_end: 90,
      start: [1, 0], end: [0, 1], projected: true, source: '@sketch0/arc1',
    }
    expect(isProjectedEntity(e)).toBe(true)
  })

  it('returns true for a projected point', () => {
    const e: Entity = { x: 1, y: 2, projected: true, source: '@sketch0/p1' }
    expect(isProjectedEntity(e)).toBe(true)
  })
})

describe('isProjectedLine', () => {
  it('returns false for a regular line', () => {
    expect(isProjectedLine(regularLine)).toBe(false)
  })

  it('returns false for a projected circle (wrong kind)', () => {
    const e: Entity = { center: [0, 0], radius: 2, projected: true, source: '@sketch0/circle1' }
    expect(isProjectedLine(e)).toBe(false)
  })

  it('returns true for a projected line', () => {
    const e: Entity = { start: [0, 0], end: [1, 0], projected: true, source: '@sketch0/line1' }
    expect(isProjectedLine(e)).toBe(true)
  })

  it('returns false for a projected arc (has radius)', () => {
    const e: Entity = {
      center: [0, 0], radius: 1, angle_start: 0, angle_end: 90,
      start: [1, 0], end: [0, 1], projected: true, source: '@sketch0/arc1',
    }
    expect(isProjectedLine(e)).toBe(false)
  })
})

describe('isProjectedCircle', () => {
  it('returns false for a regular circle', () => {
    expect(isProjectedCircle(regularCircle)).toBe(false)
  })

  it('returns true for a projected circle', () => {
    const e: Entity = { center: [0, 0], radius: 2, projected: true, source: '@sketch0/circle1' }
    expect(isProjectedCircle(e)).toBe(true)
  })

  it('returns false for a projected arc (has angle_start)', () => {
    const e: Entity = {
      center: [0, 0], radius: 1, angle_start: 0, angle_end: 90,
      start: [1, 0], end: [0, 1], projected: true, source: '@sketch0/arc1',
    }
    expect(isProjectedCircle(e)).toBe(false)
  })
})

describe('isProjectedArc', () => {
  it('returns false for a regular arc', () => {
    expect(isProjectedArc(regularArc)).toBe(false)
  })

  it('returns true for a projected arc', () => {
    const e: Entity = {
      center: [0, 0], radius: 1, angle_start: 0, angle_end: 90,
      start: [1, 0], end: [0, 1], projected: true, source: '@sketch0/arc1',
    }
    expect(isProjectedArc(e)).toBe(true)
  })

  it('returns false for a projected circle (no angle_start)', () => {
    const e: Entity = { center: [0, 0], radius: 2, projected: true, source: '@sketch0/circle1' }
    expect(isProjectedArc(e)).toBe(false)
  })
})

describe('isProjectedPoint', () => {
  it('returns false for a regular point', () => {
    expect(isProjectedPoint(regularPoint)).toBe(false)
  })

  it('returns true for a projected point', () => {
    const e: Entity = { x: 1, y: 2, projected: true, source: '@sketch0/p1' }
    expect(isProjectedPoint(e)).toBe(true)
  })

  it('returns false for a projected line (no x field)', () => {
    const e: Entity = { start: [0, 0], end: [1, 0], projected: true, source: '@sketch0/line1' }
    expect(isProjectedPoint(e)).toBe(false)
  })
})

describe('unflattenGeometry projected_line', () => {
  it('produces a projected line with correct coords', () => {
    const sketch = unflattenGeometry(
      { 'l1': [1, 2, 3, 4] },
      [{ id: 'l1', kind: 'projected_line', source: '@sketch0/line1' } as any]
    )
    const e = sketch['l1']
    expect(isProjectedLine(e)).toBe(true)
    expect((e as any).start).toEqual([1, 2])
    expect((e as any).end).toEqual([3, 4])
  })

  it('propagates source string', () => {
    const sketch = unflattenGeometry(
      { 'l1': [0, 0, 1, 0] },
      [{ id: 'l1', kind: 'projected_line', source: '@sketch0/line1' } as any]
    )
    expect((sketch['l1'] as any).source).toBe('@sketch0/line1')
  })

  it('defaults to empty source when source is missing', () => {
    const sketch = unflattenGeometry(
      { 'l1': [0, 0, 1, 0] },
      [{ id: 'l1', kind: 'projected_line' } as any]
    )
    expect((sketch['l1'] as any).source).toBe('')
  })
})

describe('unflattenGeometry projected_circle', () => {
  it('produces a projected circle with correct center and radius', () => {
    const sketch = unflattenGeometry(
      { 'c1': [5, 6, 3] },
      [{ id: 'c1', kind: 'projected_circle', source: '@sketch0/circle1' } as any]
    )
    const e = sketch['c1']
    expect(isProjectedCircle(e)).toBe(true)
    expect((e as any).center).toEqual([5, 6])
    expect((e as any).radius).toBe(3)
    expect((e as any).source).toBe('@sketch0/circle1')
  })
})

describe('unflattenGeometry projected_arc', () => {
  it('produces a projected arc with computed start/end points', () => {
    const sketch = unflattenGeometry(
      { 'a1': [0, 0, 1, 0, 90] },
      [{ id: 'a1', kind: 'projected_arc', source: '@sketch0/arc1' } as any]
    )
    const e = sketch['a1']
    expect(isProjectedArc(e)).toBe(true)
    expect((e as any).radius).toBe(1)
    expect((e as any).angle_start).toBe(0)
    expect((e as any).angle_end).toBe(90)
    // start should be at angle 0: [1, 0]
    expect((e as any).start[0]).toBeCloseTo(1)
    expect((e as any).start[1]).toBeCloseTo(0)
    // end should be at angle 90: [0, 1]
    expect((e as any).end[0]).toBeCloseTo(0)
    expect((e as any).end[1]).toBeCloseTo(1)
  })
})

describe('unflattenGeometry projected_point', () => {
  it('produces a projected point with correct coords', () => {
    const sketch = unflattenGeometry(
      { 'p1': [7, 8] },
      [{ id: 'p1', kind: 'projected_point', source: '@sketch0/p1' } as any]
    )
    const e = sketch['p1']
    expect(isProjectedPoint(e)).toBe(true)
    expect((e as any).x).toBe(7)
    expect((e as any).y).toBe(8)
    expect((e as any).source).toBe('@sketch0/p1')
  })
})

describe('unflattenGeometry non-projected entities are not marked projected', () => {
  it('regular line has no projected flag', () => {
    const sketch = unflattenGeometry(
      { 'l1': [0, 0, 1, 1] },
      [{ id: 'l1', kind: 'line' }]
    )
    expect((sketch['l1'] as any).projected).toBeUndefined()
  })

  it('regular circle has no projected flag', () => {
    const sketch = unflattenGeometry(
      { 'c1': [0, 0, 2] },
      [{ id: 'c1', kind: 'circle' }]
    )
    expect((sketch['c1'] as any).projected).toBeUndefined()
  })
})
