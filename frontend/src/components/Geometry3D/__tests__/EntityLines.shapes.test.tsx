import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Entity, Sketch, Arc, LineSegment, PointEntity, Ellipse, Spline, Circle } from '@/types/cad'

/**
 * EntityItem is the single dispatch point from a sketch entity's shape to what
 * is drawn: a sampled polyline plus the handles that belong to that shape, or
 * nothing at all for degenerate geometry. These tests pin the dispatch and the
 * degenerate bail-outs, which are the only places a malformed entity is stopped
 * before it produces NaN geometry in the scene.
 */

const MockLine = vi.fn((_props: Record<string, unknown>) => null)
const MockDashedLine = vi.fn((_props: Record<string, unknown>) => null)
const MockVertexDot = vi.fn((_props: Record<string, unknown>) => null)
const MockOriginPoint = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { MockLine(props); return null },
}))
vi.mock('@/components/Geometry3D/dimensions', () => ({
  DashedLine: (props: Record<string, unknown>) => { MockDashedLine(props); return null },
}))
vi.mock('@/components/Geometry3D/VertexDots', () => ({
  VertexDot: (props: Record<string, unknown>) => { MockVertexDot(props); return null },
  ProjectedOriginPoint: (props: Record<string, unknown>) => { MockOriginPoint(props); return null },
}))
vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

import { EntityItem, EntityLines } from '@/components/Geometry3D/EntityLines'

const ARC: Arc = { start: [1, 0], end: [0, 1], center: [0, 0], radius: 1, angle_start: 0, angle_end: 90 }
const LINE: LineSegment = { start: [0, 0], end: [1, 1] }
const POINT: PointEntity = { x: 2, y: 3 }
const ELLIPSE: Ellipse = { center: [0, 0], a: 3, b: 2, theta: 0 }
const SPLINE: Spline = { p1: [0, 0], p2: [1, 1], p3: [2, 1], p4: [3, 0] }
const CIRCLE: Circle = { center: [0, 0], radius: 2 }

function renderItem(entity: Entity, extra: Record<string, unknown> = {}) {
  return render(
    <EntityItem
      entity={entity}
      entityId="e1"
      featureId="S1"
      baseColor="#abc"
      {...extra}
    />,
  )
}

beforeEach(() => {
  MockLine.mockClear()
  MockDashedLine.mockClear()
  MockVertexDot.mockClear()
  MockOriginPoint.mockClear()
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    hoveredSelectionId: null,
    hoveredConstraintEntityIds: new Set(),
  })
})

describe('EntityItem shape dispatch', () => {
  it('draws an arc as a sampled polyline and its three handles', () => {
    renderItem(ARC as unknown as Entity)

    expect(MockLine).toHaveBeenCalledTimes(1)
    const pts = MockLine.mock.calls[0][0].points as unknown[]
    expect(pts.length).toBeGreaterThan(2)
    expect(MockVertexDot.mock.calls.map(c => c[0].vertexKey)).toEqual(['start', 'end', 'center'])
  })

  it('draws a construction arc dashed instead of solid', () => {
    renderItem({ ...ARC, construction: true } as unknown as Entity)

    expect(MockDashedLine).toHaveBeenCalledTimes(1)
    expect(MockLine).not.toHaveBeenCalled()
  })

  it('draws a line as two handles and a segment', () => {
    renderItem(LINE as Entity)

    expect(MockLine.mock.calls[0][0].points).toEqual([[0, 0, 0], [1, 1, 0]])
    expect(MockVertexDot.mock.calls.map(c => c[0].vertexKey)).toEqual(['start', 'end'])
  })

  it('draws a point entity as a larger single handle', () => {
    renderItem(POINT as Entity)

    expect(MockLine).not.toHaveBeenCalled()
    expect(MockVertexDot.mock.calls[0][0]).toMatchObject({ x: 2, y: 3, px: 5, vertexKey: 'xy' })
  })

  it('draws an ellipse as a polyline with center and four axis handles', () => {
    renderItem(ELLIPSE as Entity)

    expect(MockLine).toHaveBeenCalledTimes(1)
    expect(MockVertexDot.mock.calls.map(c => c[0].vertexKey)).toEqual(
      ['center', 'major1', 'major2', 'minor1', 'minor2'],
    )
  })

  it('draws a spline as a polyline through its four control handles', () => {
    renderItem(SPLINE as Entity)

    expect(MockLine).toHaveBeenCalledTimes(1)
    expect(MockVertexDot.mock.calls.map(c => c[0].vertexKey)).toEqual(['start', 'c1', 'c2', 'end'])
  })

  it('draws a circle as a closed polyline plus its center', () => {
    renderItem(CIRCLE as Entity)

    expect(MockLine).toHaveBeenCalledTimes(1)
    expect(MockVertexDot.mock.calls.map(c => c[0].vertexKey)).toEqual(['center'])
  })
})

describe('EntityItem degenerate geometry', () => {
  it('renders nothing for an arc with a non-finite radius', () => {
    renderItem({ ...ARC, radius: NaN } as unknown as Entity)
    expect(MockLine).not.toHaveBeenCalled()
    expect(MockVertexDot).not.toHaveBeenCalled()
  })

  it('renders nothing for a line with a non-finite endpoint', () => {
    renderItem({ start: [NaN, 0], end: [1, 1] } as unknown as Entity)
    expect(MockLine).not.toHaveBeenCalled()
    expect(MockVertexDot).not.toHaveBeenCalled()
  })

  it('renders nothing for a point with a non-finite coordinate', () => {
    renderItem({ x: Infinity, y: 0 } as unknown as Entity)
    expect(MockVertexDot).not.toHaveBeenCalled()
  })

  it('renders nothing for an ellipse with a non-finite axis', () => {
    renderItem({ ...ELLIPSE, a: NaN } as unknown as Entity)
    expect(MockLine).not.toHaveBeenCalled()
    expect(MockVertexDot).not.toHaveBeenCalled()
  })

  it('renders nothing for a spline with a non-finite control point', () => {
    renderItem({ ...SPLINE, p3: [NaN, 1] } as unknown as Entity)
    expect(MockLine).not.toHaveBeenCalled()
    expect(MockVertexDot).not.toHaveBeenCalled()
  })

  it('renders nothing for a circle with a non-finite radius', () => {
    renderItem({ ...CIRCLE, radius: NaN } as unknown as Entity)
    expect(MockLine).not.toHaveBeenCalled()
    expect(MockVertexDot).not.toHaveBeenCalled()
  })
})

describe('EntityLines container', () => {
  const SKETCH = {
    a: LINE,
    b: { ...LINE, projected: true },
    'p1': POINT,
  } as unknown as Sketch

  it('skips projected entities (they are drawn by ProjectedEntities)', () => {
    render(
      <EntityLines
        sketch={SKETCH}
        featureId="S1"
        color="#fff"
        kindMap={{}}
        lineWidth={1}
        isEditing={true}
      />,
    )
    // Only the plain line and point render here; the projected line does not.
    expect(MockLine).toHaveBeenCalledTimes(1)
  })

  it('resolves per-entity color through the function form', () => {
    render(
      <EntityLines
        sketch={{ a: LINE } as unknown as Sketch}
        featureId="S1"
        color={(id) => (id === 'a' ? '#hot' : '#cold')}
        kindMap={{}}
        isEditing={true}
      />,
    )
    expect(MockLine.mock.calls[0][0].color).toBe('#hot')
  })
})
