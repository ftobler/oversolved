import { describe, it, expect } from 'vitest'
import { unflattenGeometry } from '@/utils/geometry/geometryMapping'
import {
  isProjectedEntity,
  isProjectedLine,
  isProjectedCircle,
  isProjectedArc,
  isProjectedEllipse,
  isProjectedPoint,
  getEntityKind,
} from '@/types/cad'
import type { Entity, ProjectedLineSegment, ProjectedCircle, ProjectedArc, ProjectedPointEntity, ProjectedEllipse, Ellipse, LineSegment } from '@/types/cad'

describe('unflattenGeometry projected_line', () => {
  it('produces a projected line with correct start and end points', () => {
    const sketch = unflattenGeometry(
      { 'l1': [1, 2, 3, 4] },
      [{ id: 'l1', kind: 'projected_line', source: '@sketch0/line1' }]
    )
    const e = sketch['l1']
    expect(isProjectedLine(e)).toBe(true)
    expect((e as ProjectedLineSegment).start).toEqual([1, 2])
    expect((e as ProjectedLineSegment).end).toEqual([3, 4])
  })

  it('propagates source string', () => {
    const sketch = unflattenGeometry(
      { 'l1': [0, 0, 1, 0] },
      [{ id: 'l1', kind: 'projected_line', source: '@sketch0/line1' }]
    )
    expect((sketch['l1'] as ProjectedLineSegment).source).toBe('@sketch0/line1')
  })

  it('a projected_* kind without a source is not projected (projection needs a source)', () => {
    const sketch = unflattenGeometry(
      { 'l1': [0, 0, 1, 0] },
      [{ id: 'l1', kind: 'projected_line' }]
    )
    expect(isProjectedEntity(sketch['l1'])).toBe(false)
    expect((sketch['l1'] as unknown as { source?: string }).source).toBeUndefined()
  })
})

describe('unflattenGeometry base kind + source (post kind-collapse)', () => {
  it('a base-kind line carrying a source is projected', () => {
    const sketch = unflattenGeometry(
      { 'l1': [1, 2, 3, 4] },
      [{ id: 'l1', kind: 'line', source: '@sketch0/line1' }]
    )
    const e = sketch['l1']
    expect(isProjectedLine(e)).toBe(true)
    expect((e as ProjectedLineSegment).start).toEqual([1, 2])
    expect((e as ProjectedLineSegment).source).toBe('@sketch0/line1')
  })

  it('a base-kind point carrying a source is projected', () => {
    const sketch = unflattenGeometry(
      { 'p1': [7, 8] },
      [{ id: 'p1', kind: 'point', source: '@sketch0/p1' }]
    )
    expect(isProjectedPoint(sketch['p1'])).toBe(true)
    expect((sketch['p1'] as ProjectedPointEntity).source).toBe('@sketch0/p1')
  })

  it('the legacy projected_line kind and the base-kind+source form are equivalent', () => {
    const legacy = unflattenGeometry(
      { 'l1': [1, 2, 3, 4] },
      [{ id: 'l1', kind: 'projected_line', source: '@s/l' }]
    )
    const modern = unflattenGeometry(
      { 'l1': [1, 2, 3, 4] },
      [{ id: 'l1', kind: 'line', source: '@s/l' }]
    )
    expect(legacy['l1']).toEqual(modern['l1'])
  })
})

describe('unflattenGeometry projected_circle', () => {
  it('produces a projected circle with correct center and radius', () => {
    const sketch = unflattenGeometry(
      { 'c1': [5, 6, 3] },
      [{ id: 'c1', kind: 'projected_circle', source: '@sketch0/circle1' }]
    )
    const e = sketch['c1']
    expect(isProjectedCircle(e)).toBe(true)
    expect((e as ProjectedCircle).center).toEqual([5, 6])
    expect((e as ProjectedCircle).radius).toBe(3)
    expect((e as ProjectedCircle).source).toBe('@sketch0/circle1')
  })
})

describe('unflattenGeometry projected_arc', () => {
  it('produces a projected arc with computed start/end points', () => {
    const sketch = unflattenGeometry(
      { 'a1': [0, 0, 1, 0, 90] },
      [{ id: 'a1', kind: 'projected_arc', source: '@sketch0/arc1' }]
    )
    const e = sketch['a1']
    expect(isProjectedArc(e)).toBe(true)
    expect((e as ProjectedArc).radius).toBe(1)
    expect((e as ProjectedArc).angle_start).toBe(0)
    expect((e as ProjectedArc).angle_end).toBe(90)
    // start should be at angle 0: [1, 0]
    expect((e as ProjectedArc).start[0]).toBeCloseTo(1)
    expect((e as ProjectedArc).start[1]).toBeCloseTo(0)
    // end should be at angle 90: [0, 1]
    expect((e as ProjectedArc).end[0]).toBeCloseTo(0)
    expect((e as ProjectedArc).end[1]).toBeCloseTo(1)
  })
})

describe('unflattenGeometry projected_point', () => {
  it('produces a projected point with correct coords', () => {
    const sketch = unflattenGeometry(
      { 'p1': [7, 8] },
      [{ id: 'p1', kind: 'projected_point', source: '@sketch0/p1' }]
    )
    const e = sketch['p1']
    expect(isProjectedPoint(e)).toBe(true)
    expect((e as ProjectedPointEntity).x).toBe(7)
    expect((e as ProjectedPointEntity).y).toBe(8)
    expect((e as ProjectedPointEntity).source).toBe('@sketch0/p1')
  })
})

// Regular (non-projected) entities for negative tests
const regularLine = { start: [0, 0] as [number, number], end: [1, 0] as [number, number] }
const regularCircle = { center: [0, 0] as [number, number], radius: 1 }
const regularArc = { center: [0, 0] as [number, number], radius: 1, angle_start: 0, angle_end: 90, start: [1, 0] as [number, number], end: [0, 1] as [number, number] }
const regularPoint = { x: 0, y: 0 }

describe('isProjectedEntity', () => {
  it('returns false for a regular line', () => {
    expect(isProjectedEntity(regularLine as Entity)).toBe(false)
  })

  it('returns false for a regular circle', () => {
    expect(isProjectedEntity(regularCircle as Entity)).toBe(false)
  })

  it('returns false for a regular arc', () => {
    expect(isProjectedEntity(regularArc as Entity)).toBe(false)
  })

  it('returns false for a regular point', () => {
    expect(isProjectedEntity(regularPoint as Entity)).toBe(false)
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
    expect(isProjectedLine(regularLine as Entity)).toBe(false)
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
    expect(isProjectedCircle(regularCircle as Entity)).toBe(false)
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
    expect(isProjectedArc(regularArc as Entity)).toBe(false)
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
    expect(isProjectedPoint(regularPoint as Entity)).toBe(false)
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

describe('unflattenGeometry non-projected entities are not marked projected', () => {
  it('regular line has no projected flag', () => {
    const sketch = unflattenGeometry(
      { 'l1': [0, 0, 1, 1] },
      [{ id: 'l1', kind: 'line' }]
    )
    expect(('projected' in sketch['l1']) ? (sketch['l1'] as unknown as { projected: unknown }).projected : undefined).toBeUndefined()
  })

  it('regular circle has no projected flag', () => {
    const sketch = unflattenGeometry(
      { 'c1': [0, 0, 2] },
      [{ id: 'c1', kind: 'circle' }]
    )
    expect(('projected' in sketch['c1']) ? (sketch['c1'] as unknown as { projected: unknown }).projected : undefined).toBeUndefined()
  })
})

describe('unflattenGeometry ellipse', () => {
  it('unflattens [cx, cy, a, b, theta_deg] into an Ellipse', () => {
    const sketch = unflattenGeometry(
      { 'e1': [1, 2, 4, 2, 30] },
      [{ id: 'e1', kind: 'ellipse' }]
    )
    const e = sketch['e1'] as Ellipse
    expect(getEntityKind(e)).toBe('ellipse')
    expect(e.center).toEqual([1, 2])
    expect(e.a).toBe(4)
    expect(e.b).toBe(2)
    expect(e.theta).toBe(30)
    expect(isProjectedEntity(e)).toBe(false)
  })

  it('carries a source through as a projected ellipse', () => {
    const sketch = unflattenGeometry(
      { 'e1': [0, 0, 5, 3, 0] },
      [{ id: 'e1', kind: 'ellipse', source: '@sketch0/ellipse1' }]
    )
    const e = sketch['e1']
    expect(isProjectedEllipse(e)).toBe(true)
    expect((e as ProjectedEllipse).source).toBe('@sketch0/ellipse1')
    expect((e as ProjectedEllipse).a).toBe(5)
  })

  it('preserves construction flag', () => {
    const sketch = unflattenGeometry(
      { 'e1': [0, 0, 2, 1, 0] },
      [{ id: 'e1', kind: 'ellipse', construction: true }]
    )
    expect((sketch['e1'] as Ellipse).construction).toBe(true)
  })
})

describe('getEntityKind ellipse vs circle', () => {
  it('classifies an ellipse (center + a) as ellipse, not circle', () => {
    const el: Entity = { center: [0, 0], a: 4, b: 2, theta: 0 }
    expect(getEntityKind(el)).toBe('ellipse')
  })

  it('still classifies a circle (center + radius) as circle', () => {
    expect(getEntityKind(regularCircle as Entity)).toBe('circle')
  })
})

describe('isProjectedEllipse', () => {
  it('returns true for a projected ellipse', () => {
    const e: Entity = { center: [0, 0], a: 4, b: 2, theta: 0, projected: true, source: '@sketch0/ellipse1' }
    expect(isProjectedEllipse(e)).toBe(true)
  })

  it('returns false for a regular (non-projected) ellipse', () => {
    const e: Entity = { center: [0, 0], a: 4, b: 2, theta: 0 }
    expect(isProjectedEllipse(e)).toBe(false)
  })

  it('returns false for a projected circle (no a field)', () => {
    const e: Entity = { center: [0, 0], radius: 2, projected: true, source: '@sketch0/circle1' }
    expect(isProjectedEllipse(e)).toBe(false)
  })
})

describe('isProjectedCircle excludes ellipses', () => {
  it('returns false for a projected ellipse (has a, no radius)', () => {
    const e: Entity = { center: [0, 0], a: 4, b: 2, theta: 0, projected: true, source: '@sketch0/ellipse1' }
    expect(isProjectedCircle(e)).toBe(false)
  })
})

// Keep this import so the LineSegment type is used
const _lineCheck: LineSegment = regularLine
void _lineCheck
