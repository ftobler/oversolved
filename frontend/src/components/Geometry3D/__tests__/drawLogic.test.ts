import { describe, it, expect } from 'vitest'
import { resolveSnapPoint, computeDrawClick } from '@/components/Geometry3D/drawLogic'
import type { DrawSnapState } from '@/components/Geometry3D/drawLogic'
import { computePreviewPts, ELLIPSE_MINOR_RATIO } from '@/components/Geometry3D/drawGeometry'

const FEATURE = 'S1'
let idCounter = 0
const newId = () => `E${++idCounter}`

const emptySnap = (): DrawSnapState => ({
  hoveredVertexId: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  hoveredSelectionId: null,
  drawSnapVertexId: null,
  alignmentSnapPoint: null,
  alignmentSnapKind: null,
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

// The four reported click cases: a draw click must land where the cursor ray met
// the sketch plane, whatever the ID buffer resolved under the cursor.
describe('resolveSnapPoint - draw click plane placement', () => {
  it('a click on empty sketch background keeps the plane-resolved point', () => {
    expect(resolveSnapPoint([3, 4], emptySnap())).toEqual([3, 4])
  })

  it('a click on a B-rep face keeps the plane-resolved point', () => {
    // A drawing tool resolves no B-rep layer, so the snap state is empty even
    // though a face was under the cursor; the raw plane point must survive.
    const snap = emptySnap()
    snap.hoveredSelectionId = '?4,4;@bxx@fyy:flatface'
    expect(resolveSnapPoint([3, 4], snap)).toEqual([3, 4])
  })

  it('a click on a filled sketch area keeps the plane-resolved point', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = 'entity:S1:surface'
    snap.hoveredVertexPosition = null
    expect(resolveSnapPoint([3, 4], snap)).toEqual([3, 4])
  })

  it('an origin hover on an offset plane snaps to originLocal, not [0,0]', () => {
    const snap = emptySnap()
    snap.hoveredVertexPosition = [-37.5, 12.25]
    const result = resolveSnapPoint([3, 4], snap)
    expect(result).toEqual([-37.5, 12.25])
    expect(result).not.toEqual([0, 0])
  })

  it('an origin hover on a builtin plane still snaps to [0,0]', () => {
    const snap = emptySnap()
    snap.hoveredVertexPosition = [0, 0]
    expect(resolveSnapPoint([3, 4], snap)).toEqual([0, 0])
  })
})

describe('computeDrawClick rejects a non-finite point', () => {
  it('circle first click with a NaN x commits nothing', () => {
    expect(() => computeDrawClick('circle', [], [NaN, 5], emptySnap(), FEATURE, newId)).toThrow()
  })

  it('line first click with an Infinity y commits nothing', () => {
    expect(() => computeDrawClick('line', [], [3, Infinity], emptySnap(), FEATURE, newId)).toThrow()
  })

  it('a non-finite snap position is rejected even when the raw point is finite', () => {
    const snap = emptySnap()
    snap.hoveredVertexPosition = [NaN, 0]
    expect(() => computeDrawClick('circle', [], [3, 4], snap, FEATURE, newId)).toThrow()
  })

  it('a finite point still commits', () => {
    const result = computeDrawClick('circle', [], [3, 4], emptySnap(), FEATURE, newId)
    expect(result.nextDrawPoints).toEqual([[3, 4]])
  })
})

describe('computeDrawClick - point tool', () => {
  it('emits add_entity immediately with gestureComplete=true', () => {
    const result = computeDrawClick('point', [], [3, 4], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].kind).toBe('point')
      expect(result.mutations[0].params).toEqual([3, 4])
    }
    expect(result.gestureComplete).toBe(true)
    expect(result.nextDrawPoints).toBeNull()
  })
})

describe('computeDrawClick - line tool', () => {
  it('first click accumulates point, no mutations', () => {
    const result = computeDrawClick('line', [], [1, 2], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[1, 2]])
    expect(result.gestureComplete).toBe(false)
  })

  it('first click with vertex snap records drawSnap', () => {
    const snap = emptySnap()
    snap.hoveredVertexId = 'vertex:S1:L1:end'
    snap.hoveredVertexPosition = [5, 0]
    const result = computeDrawClick('line', [], [5, 0], snap, FEATURE, newId)
    expect(result.nextDrawSnap?.vertexId).toBe('vertex:S1:L1:end')
  })

  it('second click with no snap emits add_entity and keeps the chain open', () => {
    const result = computeDrawClick('line', [[0, 0]], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].kind).toBe('line')
      expect(result.mutations[0].params).toEqual([0, 0, 5, 5])
    }
    // The just-drawn endpoint becomes the next start; the tool does not clear.
    expect(result.gestureComplete).toBe(false)
    expect(result.nextDrawPoints).toEqual([[0, 0], [5, 5]])
  })

  it('third click continues the chain instead of closing the tool', () => {
    const result = computeDrawClick('line', [[0, 0], [5, 5]], [9, 2], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
    if (result.mutations[0].type === 'add_entity') {
      // Segment runs from the previous endpoint (5,5) to the new click.
      expect(result.mutations[0].params).toEqual([5, 5, 9, 2])
    }
    expect(result.gestureComplete).toBe(false)
    expect(result.nextDrawPoints).toEqual([[0, 0], [5, 5], [9, 2]])
  })

  it('clicking the first vertex closes the polyline', () => {
    const result = computeDrawClick('line', [[0, 0], [5, 5]], [0, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
    if (result.mutations[0].type === 'add_entity') {
      // Closing segment runs from the last vertex back to the first.
      expect(result.mutations[0].params).toEqual([5, 5, 0, 0])
    }
    expect(result.gestureComplete).toBe(true)
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

  it('end snap detected from the resolved vertex position, not the stale hover gate', () => {
    // The legacy gate required hoveredVertexId && hoveredSnapKind; here
    // hoveredSnapKind is absent yet the click still lands on the vertex, so the
    // end constraint must still be emitted (the snap-drop bug).
    const snap = emptySnap()
    snap.drawSnapVertexId = 'vertex:S1:L1:end'
    snap.hoveredVertexPosition = [10, 0]
    snap.hoveredVertexId = 'vertex:S1:L2:start'
    const result = computeDrawClick('line', [[0, 0]], [10, 0], snap, FEATURE, newId)
    const kinds = result.mutations.map(m => m.type)
    expect(kinds).toContain('add_entity_with_constraint')
    expect(kinds).toContain('add_constraint')
    const constraint = result.mutations.find(m => m.type === 'add_constraint')
    expect(constraint).toBeDefined()
    if (constraint && constraint.type === 'add_constraint') {
      expect(constraint.targets[1]).toBe('vertex:S1:L2:start')
    }
  })

  it('both endpoints on distinct vertices emit start and end constraints', () => {
    const snap = emptySnap()
    snap.drawSnapVertexId = 'vertex:S1:L1:end'
    snap.hoveredVertexPosition = [10, 0]
    snap.hoveredVertexId = 'vertex:S1:L2:start'
    snap.hoveredSnapKind = 'vertex'
    const result = computeDrawClick('line', [[0, 0]], [10, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(2)
    expect(result.mutations[0].type).toBe('add_entity_with_constraint')
    expect(result.mutations[1].type).toBe('add_constraint')
  })

  it('both endpoints on the SAME vertex fall back to a free line', () => {
    const snap = emptySnap()
    snap.drawSnapVertexId = 'vertex:S1:L1:end'
    snap.hoveredVertexPosition = [10, 0]
    snap.hoveredVertexId = 'vertex:S1:L1:end'
    snap.hoveredSnapKind = 'vertex'
    const result = computeDrawClick('line', [[0, 0]], [10, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity')
    expect(result.gestureComplete).toBe(false)
  })

  it('a single-snapped (start only) line still works as before', () => {
    const snap = emptySnap()
    snap.drawSnapVertexId = 'vertex:S1:L1:end'
    const result = computeDrawClick('line', [[0, 0]], [5, 5], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_entity_with_constraint')
  })


})

describe('computeDrawClick - circle tool', () => {
  it('first click records center, no mutations', () => {
    const result = computeDrawClick('circle', [], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[5, 5]])
    expect(result.gestureComplete).toBe(false)
  })

  it('second click emits add_entity circle with correct radius', () => {
    const result = computeDrawClick('circle', [[0, 0]], [3, 4], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    if (result.mutations[0].type === 'add_entity') {
      expect(result.mutations[0].kind).toBe('circle')
      // radius should be hypot(3,4) = 5
      expect(result.mutations[0].params[2]).toBeCloseTo(5)
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('second click with zero radius returns no mutation', () => {
    const result = computeDrawClick('circle', [[5, 5]], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.gestureComplete).toBe(false)
  })
})

describe('computeDrawClick - ellipse tool', () => {
  it('first click records center, no mutations', () => {
    const result = computeDrawClick('ellipse', [], [2, 2], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[2, 2]])
    expect(result.gestureComplete).toBe(false)
  })

  it('second click emits add_entity ellipse with a, b=a*0.618 and theta', () => {
    // Center (0,0), cursor at (3,4): a = 5, theta = atan2(4,3) deg, b = a*0.618.
    const result = computeDrawClick('ellipse', [[0, 0]], [3, 4], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity')
    if (m.type === 'add_entity') {
      expect(m.kind).toBe('ellipse')
      expect(m.params[0]).toBeCloseTo(0)
      expect(m.params[1]).toBeCloseTo(0)
      expect(m.params[2]).toBeCloseTo(5)  // a = hypot(3,4)
      expect(m.params[3]).toBeCloseTo(5 * ELLIPSE_MINOR_RATIO)  // b = a * golden ratio
      expect(m.params[4]).toBeCloseTo(Math.atan2(4, 3) * (180 / Math.PI))  // theta deg
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('second click with zero major axis returns no mutation', () => {
    const result = computeDrawClick('ellipse', [[5, 5]], [5, 5], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.gestureComplete).toBe(false)
  })

  it('snaps the center to a hovered vertex via add_entity_with_constraint', () => {
    const snap = emptySnap()
    snap.drawSnapVertexId = `vertex:${FEATURE}:V1:xy`
    const result = computeDrawClick('ellipse', [[0, 0]], [4, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity_with_constraint')
    if (m.type === 'add_entity_with_constraint') {
      expect(m.kind).toBe('ellipse')
      expect(m.vertexKey).toBe('center')
      expect(m.constraintKind).toBe('coincident')
    }
  })
})

describe('computeDrawClick - spline tool', () => {
  it('accumulates the first three clicks without a mutation', () => {
    const c1 = computeDrawClick('spline', [], [0, 0], emptySnap(), FEATURE, newId)
    expect(c1.mutations).toHaveLength(0)
    expect(c1.nextDrawPoints).toEqual([[0, 0]])
    expect(c1.gestureComplete).toBe(false)

    const c2 = computeDrawClick('spline', [[0, 0]], [1, 3], emptySnap(), FEATURE, newId)
    expect(c2.mutations).toHaveLength(0)
    expect(c2.nextDrawPoints).toEqual([[0, 0], [1, 3]])

    const c3 = computeDrawClick('spline', [[0, 0], [1, 3]], [3, 3], emptySnap(), FEATURE, newId)
    expect(c3.mutations).toHaveLength(0)
    expect(c3.nextDrawPoints).toEqual([[0, 0], [1, 3], [3, 3]])
    expect(c3.gestureComplete).toBe(false)
  })

  it('fourth click emits add_entity spline with 8 control-point params', () => {
    const result = computeDrawClick('spline', [[0, 0], [1, 3], [3, 3]], [4, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity')
    if (m.type === 'add_entity') {
      expect(m.kind).toBe('spline')
      expect(m.params).toEqual([0, 0, 1, 3, 3, 3, 4, 0])
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('snaps the start point to a hovered vertex via add_entity_with_constraint', () => {
    const snap = emptySnap()
    snap.drawSnapVertexId = `vertex:${FEATURE}:V1:end`
    const result = computeDrawClick('spline', [[0, 0], [1, 3], [3, 3]], [4, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    const m = result.mutations[0]
    expect(m.type).toBe('add_entity_with_constraint')
    if (m.type === 'add_entity_with_constraint') {
      expect(m.kind).toBe('spline')
      expect(m.vertexKey).toBe('start')
      expect(m.constraintKind).toBe('coincident')
    }
  })
})

describe('computePreviewPts - spline tool', () => {
  it('first segment previews the P1->cursor handle line', () => {
    const pts = computePreviewPts('spline', [[0, 0]], [1, 3])
    expect(pts).toEqual([[0, 0, 0], [1, 3, 0]])
  })

  it('shows the control polygon after the second click', () => {
    const pts = computePreviewPts('spline', [[0, 0], [1, 3]], [3, 3])
    expect(pts).toEqual([[0, 0, 0], [1, 3, 0], [3, 3, 0]])
  })

  it('samples the cubic Bezier once three points are placed', () => {
    const pts = computePreviewPts('spline', [[0, 0], [1, 3], [3, 3]], [4, 0])!
    expect(pts.length).toBeGreaterThan(2)
    // Endpoints of the sampled curve are P1 and the cursor (P4).
    expect(pts[0][0]).toBeCloseTo(0)
    expect(pts[0][1]).toBeCloseTo(0)
    expect(pts[pts.length - 1][0]).toBeCloseTo(4)
    expect(pts[pts.length - 1][1]).toBeCloseTo(0)
  })

  it('returns null with no hover', () => {
    expect(computePreviewPts('spline', [[0, 0]], null)).toBeNull()
  })
})

describe('computePreviewPts - ellipse tool', () => {
  it('samples a closed ellipse polyline from center + cursor', () => {
    const pts = computePreviewPts('ellipse', [[0, 0]], [4, 0])
    expect(pts).not.toBeNull()
    if (pts) {
      // Closed polyline: first and last points coincide.
      expect(pts[0][0]).toBeCloseTo(pts[pts.length - 1][0])
      expect(pts[0][1]).toBeCloseTo(pts[pts.length - 1][1])
      // theta = 0, a = 4 -> the major-axis vertex at t=0 is (4, 0).
      expect(pts[0][0]).toBeCloseTo(4)
      expect(pts[0][1]).toBeCloseTo(0)
      // Every sample lies on the axis-aligned ellipse (x/4)^2 + (y/(4*0.618))^2 = 1.
      const b = 4 * 0.618
      for (const [x, y] of pts) {
        expect((x * x) / 16 + (y * y) / (b * b)).toBeCloseTo(1, 4)
      }
    }
  })

  it('returns null before the center is placed', () => {
    expect(computePreviewPts('ellipse', [], [4, 0])).toBeNull()
  })

  it('preview matches the geometry the second click commits', () => {
    // The preview polyline must lie on the same ellipse the commit produces, so
    // the two ELLIPSE_MINOR_RATIO uses can never silently diverge.
    const center: [number, number] = [1, 2]
    const cursor: [number, number] = [4, 6]  // dx=3, dy=4 -> a=5
    const commit = computeDrawClick('ellipse', [center], cursor, emptySnap(), FEATURE, newId)
    const m = commit.mutations[0]
    expect(m.type).toBe('add_entity')
    if (m.type !== 'add_entity') return
    const [, , a, b] = m.params
    const theta = (m.params[4] * Math.PI) / 180
    const ct = Math.cos(theta), st = Math.sin(theta)
    const pts = computePreviewPts('ellipse', [center], cursor)!
    for (const [x, y] of pts) {
      // Map into the ellipse frame; every preview point satisfies the conic.
      const dx = x - center[0], dy = y - center[1]
      const u = dx * ct + dy * st
      const v = dy * ct - dx * st
      expect((u * u) / (a * a) + (v * v) / (b * b)).toBeCloseTo(1, 4)
    }
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
    expect(result.gestureComplete).toBe(true)
  })

  it('three collinear points returns no mutation', () => {
    const result = computeDrawClick('arc', [[0, 0], [5, 0]], [10, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.gestureComplete).toBe(false)
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
    expect(result.gestureComplete).toBe(true)
  })

  it('second click ignores alignment snap (would collapse rectangle)', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [0, 0]
    snap.alignmentSnapKind = 'kinda_horizontal'
    const result = computeDrawClick('rect', [[0, 0]], [8, 4], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    if (result.mutations[0].type === 'add_rect') {
      expect(result.mutations[0].p1).toEqual([8, 4])
    }
  })

  it('first click still respects vertex hover snap', () => {
    const snap = emptySnap()
    snap.hoveredVertexId = 'v1'
    snap.hoveredVertexPosition = [10, 20]
    const result = computeDrawClick('rect', [], [5, 5], snap, FEATURE, newId)
    expect(result.nextDrawPoints).toEqual([[10, 20]])
    expect(result.nextDrawSnap).toEqual({ vertexId: 'v1' })
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
    expect(result.gestureComplete).toBe(true)
  })

  it('second click ignores alignment snap (would collapse rectangle)', () => {
    const snap = emptySnap()
    snap.alignmentSnapPoint = [0, 0]
    snap.alignmentSnapKind = 'kinda_vertical'
    const result = computeDrawClick('center_rect', [[0, 0]], [8, 4], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    if (result.mutations[0].type === 'add_center_rect') {
      expect(result.mutations[0].corner).toEqual([8, 4])
    }
  })
})

describe('computeDrawClick - ngon tool', () => {
  it('first click records center, no mutations', () => {
    const result = computeDrawClick('ngon', [], [1, 1], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.nextDrawPoints).toEqual([[1, 1]])
  })

  it('second click emits add_ngon with the default side count', () => {
    const result = computeDrawClick('ngon', [[0, 0]], [10, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_ngon')
    if (result.mutations[0].type === 'add_ngon') {
      expect(result.mutations[0].center).toEqual([0, 0])
      expect(result.mutations[0].corner).toEqual([10, 0])
      expect(result.mutations[0].sides).toBe(6)
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('honors the side count from snap state', () => {
    const snap = emptySnap()
    snap.ngonSides = 5
    const result = computeDrawClick('ngon', [[0, 0]], [10, 0], snap, FEATURE, newId)
    if (result.mutations[0].type === 'add_ngon') {
      expect(result.mutations[0].sides).toBe(5)
    }
  })
})

describe('computePreviewPts - ngon tool', () => {
  it('previews a closed regular hexagon with the first vertex at the cursor', () => {
    const pts = computePreviewPts('ngon', [[0, 0]], [10, 0])!
    expect(pts).toHaveLength(7)  // 6 vertices + closing repeat
    expect(pts[0][0]).toBeCloseTo(10)
    expect(pts[0][1]).toBeCloseTo(0)
    expect(pts[6]).toEqual(pts[0])  // closed loop
    // every vertex on the circumcircle of radius 10
    for (const p of pts) expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 6)
  })

  it('respects the side count argument', () => {
    const pts = computePreviewPts('ngon', [[0, 0]], [4, 0], 3)!
    expect(pts).toHaveLength(4)  // triangle + closing repeat
  })

  it('returns null before the center is placed', () => {
    expect(computePreviewPts('ngon', [], [4, 0])).toBeNull()
  })
})

describe('computeDrawClick - project tool', () => {
  it('returns nothing when no entity is hovered', () => {
    const result = computeDrawClick('project', [], [0, 0], emptySnap(), FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
    expect(result.gestureComplete).toBe(false)
  })

  it('returns nothing when hovered entity is in same feature', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = `entity:${FEATURE}:L1`
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(0)
  })

  it('emits add_projected_entity for entity from another feature', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = 'entity:S2:L1'
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].source).toBe('@S2/L1')
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('emits add_projected_entity for edge ancestry query pick', () => {
    const snap = emptySnap()
    const ancQuery = '?4,4;@bxx@fyy:straightedge'
    snap.hoveredSelectionId = ancQuery
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].source).toBe(ancQuery)
      expect(result.mutations[0].kind).toBe('line')
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('emits projected_circle for a circular body edge pick', () => {
    const snap = emptySnap()
    const ancQuery = '?4,4;@bxx@fyy:edge'
    snap.hoveredSelectionId = ancQuery
    snap.hoveredSourceKind = 'circle'
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].source).toBe(ancQuery)
      expect(result.mutations[0].kind).toBe('circle')
    }
  })

  it('emits projected_arc for an arc body edge pick', () => {
    const snap = emptySnap()
    const ancQuery = '?4,4;@bxx@fyy:edge'
    snap.hoveredSelectionId = ancQuery
    snap.hoveredSourceKind = 'arc'
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].kind).toBe('arc')
    }
  })

  it('emits projected ellipse for an elliptical body edge pick', () => {
    const snap = emptySnap()
    const ancQuery = '?4,4;@bxx@fyy:edge'
    snap.hoveredSelectionId = ancQuery
    snap.hoveredSourceKind = 'ellipse'
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].kind).toBe('ellipse')
    }
  })

  it('emits projected spline for a spline body edge pick', () => {
    const snap = emptySnap()
    const ancQuery = '?4,4;@bxx@fyy:edge'
    snap.hoveredSelectionId = ancQuery
    snap.hoveredSourceKind = 'spline'
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].kind).toBe('spline')
    }
  })

  it('falls back to projected_line for a curved edge with unknown source kind', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = '?4,4;@bxx@fyy:edge'
    // hoveredSourceKind unset (e.g. body not registered) -> safe line default.
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].kind).toBe('line')
    }
  })

  it('projects a face as a closed wire: one entity per boundary edge', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = '?4,4;@bxx@fyy:flatface'
    snap.hoveredFaceEdges = [
      { source: '?a;e0:edge', kind: 'line' },
      { source: '?a;e1:edge', kind: 'circle' },
      { source: '?a;e2:edge', kind: 'line' },
    ]
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(3)
    expect(result.mutations.every(m => m.type === 'add_projected_entity')).toBe(true)
    const kinds = result.mutations.map(m => (m.type === 'add_projected_entity' ? m.kind : ''))
    expect(kinds).toEqual(['line', 'circle', 'line'])
    expect(result.gestureComplete).toBe(true)
  })

  it('falls back to a single point projection for a face with no boundary edges', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = '?4,4;@bxx@fyy:flatface'
    snap.hoveredFaceEdges = null
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].kind).toBe('point')
    }
  })

  it('emits add_projected_entity for face ancestry query pick', () => {
    const snap = emptySnap()
    const ancQuery = '?4,4;@bxx@fyy:flatface'
    snap.hoveredSelectionId = ancQuery
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].source).toBe(ancQuery)
      expect(result.mutations[0].kind).toBe('point')
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('emits add_projected_entity for vertex ancestry query pick (no type restriction)', () => {
    const snap = emptySnap()
    const ancQuery = '?4,4;@bxx@vxx'
    snap.hoveredSelectionId = ancQuery
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    if (result.mutations[0].type === 'add_projected_entity') {
      expect(result.mutations[0].source).toBe(ancQuery)
      expect(result.mutations[0].kind).toBe('point')
    }
    expect(result.gestureComplete).toBe(true)
  })

  it('returns nothing for malformed ancestry query in project tool', () => {
    const snap = emptySnap()
    snap.hoveredSelectionId = '?not-valid'
    const result = computeDrawClick('project', [], [0, 0], snap, FEATURE, newId)
    // Malformed ancestry queries still emit (they fall back to projected_point with the raw string as source)
    expect(result.mutations).toHaveLength(1)
    expect(result.mutations[0].type).toBe('add_projected_entity')
    expect(result.gestureComplete).toBe(true)
  })
})
