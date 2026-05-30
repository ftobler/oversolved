import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { LineSegment, Sketch } from '@/types/cad'
import { COLOR_PROJECTED, COLOR_INACTIVE, RENDER_ORDER_EDITING } from '@/components/Geometry3D/constants'

const MockLine = vi.fn((_props: Record<string, unknown>) => null)
const MockDashedLine = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { MockLine(props); return null },
}))

vi.mock('@/components/sketch_dimensions', () => ({
  DashedLine: (props: Record<string, unknown>) => { MockDashedLine(props); return null },
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

vi.mock('@/components/Geometry3D/VertexDots', () => ({
  VertexDot: () => null,
  ProjectedOriginPoint: () => null,
}))

vi.mock('@/components/sketch_helpers', () => ({
  sampleArc: () => [[0, 0, 0], [1, 0, 0]],
  sampleArcCCW: () => [[0, 0, 0], [1, 0, 0]],
  pointTo3D: (p: [number, number]) => [p[0], p[1], 0],
  allFinite: () => true,
  p2w: () => 1,
}))

const LINE_ENTITY: LineSegment = { start: [0, 0], end: [1, 0] }
const LINE_ENTITY_CONSTRUCTION: LineSegment = { start: [0, 0], end: [1, 0], construction: true }

function resetStore(overrides: Record<string, unknown> = {}) {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    activeFeatureId: null,
    drag: null,
    hoveredConstraintEntityIds: new Set(),
    setInternalHoverSelection: vi.fn(),
    ...overrides,
  } as never)
}

beforeEach(() => {
  MockLine.mockClear()
  MockDashedLine.mockClear()
  resetStore()
})

describe('EntityItem selected-entity render order', () => {
  it('selected entity outside edit mode gets renderOrder > 0', async () => {
    const { EntityItem } = await import('@/components/Geometry3D/EntityLines')
    const entId = 'entity:sketch1:line1'
    resetStore({ normalSelection: new Set([entId]) })

    render(
      <EntityItem
        entity={LINE_ENTITY}
        entityId="line1"
        entityKind="line"
        featureId="sketch1"
        baseColor="#aaaaaa"
        isEditing={false}
      />
    )

    const props = MockLine.mock.calls[0]?.[0] as Record<string, unknown>
    expect(typeof props.renderOrder).toBe('number')
    expect((props.renderOrder as number) > 0).toBe(true)
  })

  it('selected construction entity outside edit mode gets depthTest=false', async () => {
    const { EntityItem } = await import('@/components/Geometry3D/EntityLines')
    const entId = 'entity:sketch1:line1'
    resetStore({ normalSelection: new Set([entId]) })

    render(
      <EntityItem
        entity={LINE_ENTITY_CONSTRUCTION}
        entityId="line1"
        entityKind="line"
        featureId="sketch1"
        baseColor="#aaaaaa"
        isEditing={false}
      />
    )

    const props = MockDashedLine.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.depthTest).toBe(false)
    expect((props.renderOrder as number) > 0).toBe(true)
  })

  it('hovered-only (not selected) entity outside edit mode does not get high renderOrder', async () => {
      // hovered is always false for this test
    // nothing in normalSelection → selected=false
    const { EntityItem } = await import('@/components/Geometry3D/EntityLines')
    resetStore({ normalSelection: new Set() })

    render(
      <EntityItem
        entity={LINE_ENTITY}
        entityId="line1"
        entityKind="line"
        featureId="sketch1"
        baseColor="#aaaaaa"
        isEditing={false}
      />
    )

    const props = MockLine.mock.calls[0]?.[0] as Record<string, unknown>
    // renderOrder should be undefined or 0 when not selected and not editing
    const ro = props.renderOrder as number | undefined
    expect(ro == null || ro === 0).toBe(true)
  })
})

describe('ProjectedEntities color and render order', () => {
  const PROJECTED_LINE = { start: [0, 0], end: [1, 0], projected: true }
  const SKETCH: Sketch = { p1: PROJECTED_LINE } as unknown as Sketch

  it('renders amber and shares the sketch edit render order while editing', async () => {
    const { ProjectedEntities } = await import('@/components/Geometry3D/EntityLines')
    render(<ProjectedEntities sketch={SKETCH} featureId="sketch1" isEditing={true} />)

    const props = MockLine.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.color).toBe(COLOR_PROJECTED)
    expect(props.renderOrder).toBe(RENDER_ORDER_EDITING)
    expect(props.depthTest).toBe(false)
  })

  it('renders grey (inactive) when the sketch is not being edited', async () => {
    const { ProjectedEntities } = await import('@/components/Geometry3D/EntityLines')
    render(<ProjectedEntities sketch={SKETCH} featureId="sketch1" isEditing={false} />)

    const props = MockLine.mock.calls[0]?.[0] as Record<string, unknown>
    expect(props.color).toBe(COLOR_INACTIVE)
    const ro = props.renderOrder as number | undefined
    expect(ro == null || ro === 0).toBe(true)
  })
})
