import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Sketch } from '@/types/cad'

/**
 * DimensionPreview synthesises a ghost dimension from the dimension tool's
 * current picks plus the cursor. Its useful behaviour is the branch selection:
 * which gate bails (inactive tool, no picks, unresolved, inactive feature), and
 * which sub-renderer a resolved kind dispatches to. The helper modules are
 * stubbed so the assertions pin the component's own decisions and the exact
 * constraint shape it builds, not the geometry math (already tested).
 */

const spies = vi.hoisted(() => ({
  resolveDimension: vi.fn(),
  dimensionTargets: vi.fn(),
  computeConstraintRender: vi.fn(),
  computeNaturalDimensionValue: vi.fn(),
  computeAnchorRelativePos: vi.fn(),
  resolveDimPoints: vi.fn(),
  linear: vi.fn(),
  radius: vi.fn(),
  diameter: vi.fn(),
  angle: vi.fn(),
}))

vi.mock('@/registry', () => ({
  resolveDimension: (...a: unknown[]) => spies.resolveDimension(...a),
  dimensionTargets: (...a: unknown[]) => spies.dimensionTargets(...a),
}))
vi.mock('@/utils/geometry/geometryMapping', () => ({
  computeConstraintRender: (...a: unknown[]) => spies.computeConstraintRender(...a),
}))
vi.mock('@/utils/geometry/dimensionNaturalValue', () => ({
  computeNaturalDimensionValue: (...a: unknown[]) => spies.computeNaturalDimensionValue(...a),
  computeAnchorRelativePos: (...a: unknown[]) => spies.computeAnchorRelativePos(...a),
  resolveDimPoints: (...a: unknown[]) => spies.resolveDimPoints(...a),
}))
vi.mock('../Linear', () => ({
  LinearDimension: (p: Record<string, unknown>) => { spies.linear(p); return <div data-testid="linear" /> },
}))
vi.mock('../Radial', () => ({
  RadiusDimension: (p: Record<string, unknown>) => { spies.radius(p); return <div data-testid="radius" /> },
  DiameterDimension: (p: Record<string, unknown>) => { spies.diameter(p); return <div data-testid="diameter" /> },
}))
vi.mock('../Angle', () => ({
  AngleDimension: (p: Record<string, unknown>) => { spies.angle(p); return <div data-testid="angle" /> },
}))

import { DimensionPreview } from '../Preview'

const SKETCH = {} as Sketch
const PICKS = [
  { isVertex: false, target: 'entity:S1:L1', entityKind: 'line' },
  { isVertex: false, target: 'entity:S1:L2', entityKind: 'line' },
]

function renderPreview(overrides: Partial<React.ComponentProps<typeof DimensionPreview>> = {}) {
  return render(
    <DimensionPreview featureId="S1" activeFeatureId="S1" sketch={SKETCH} {...overrides} />,
  )
}

beforeEach(() => {
  for (const s of Object.values(spies)) s.mockClear()
  spies.resolveDimension.mockReturnValue({ constraintKind: 'length' })
  spies.dimensionTargets.mockReturnValue(['entity:S1:L1'])
  spies.computeNaturalDimensionValue.mockReturnValue(42)
  spies.computeAnchorRelativePos.mockReturnValue(null)
  spies.computeConstraintRender.mockReturnValue({ kind: 'dim_radius', p1: [0, 0], p2: [5, 0], value: 5 })
  useSketchEditorStore.setState({ activeTool: 'dimension', dimensionPicks: PICKS, dimensionCursorWorld: null })
})

describe('DimensionPreview gates', () => {
  it('renders nothing when the dimension tool is not active', () => {
    useSketchEditorStore.setState({ activeTool: 'line' })
    const { container } = renderPreview()

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing without any picks', () => {
    useSketchEditorStore.setState({ dimensionPicks: [] })
    const { container } = renderPreview()

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the pick set does not resolve to a dimension', () => {
    spies.resolveDimension.mockReturnValue(null)
    const { container } = renderPreview()

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the preview is not for the active feature', () => {
    spies.computeConstraintRender.mockReturnValue({ kind: 'dim_radius', p1: [0, 0], p2: [5, 0], value: 5 })
    const { container } = renderPreview({ featureId: 'S2', activeFeatureId: 'S1' })

    expect(container.firstChild).toBeNull()
  })
})

describe('DimensionPreview kind dispatch', () => {
  it('dispatches dim_linear with the fixed offset and no interaction (non-pickable)', () => {
    spies.resolveDimension.mockReturnValue({ constraintKind: 'length' })
    spies.computeConstraintRender.mockReturnValue({ kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 })
    renderPreview()

    expect(spies.linear).toHaveBeenCalledTimes(1)
    const props = spies.linear.mock.calls[0][0]
    expect(props.cid).toBe('__dim-preview__')
    expect(props.dimOffset).toBe(10)
    expect(props.dim.kind).toBe('dim_linear')
    expect(props.interaction).toBeUndefined()
  })

  it('dispatches dim_radius to the radius renderer', () => {
    spies.computeConstraintRender.mockReturnValue({ kind: 'dim_radius', p1: [0, 0], p2: [5, 0], value: 5 })
    renderPreview()

    expect(spies.radius).toHaveBeenCalledTimes(1)
    expect(spies.radius.mock.calls[0][0].cid).toBe('__dim-preview__')
  })

  it('dispatches dim_diameter to the diameter renderer', () => {
    spies.computeConstraintRender.mockReturnValue({ kind: 'dim_diameter', p1: [0, 0], p2: [5, 0], value: 5 })
    renderPreview()

    expect(spies.diameter).toHaveBeenCalledTimes(1)
  })

  it('dispatches dim_angle to the angle renderer', () => {
    spies.computeConstraintRender.mockReturnValue({ kind: 'dim_angle', p1: [0, 0], p2: [1, 0], p3: [0, 0], p4: [0, 1], value: 90 })
    renderPreview()

    expect(spies.angle).toHaveBeenCalledTimes(1)
  })

  it('renders nothing for a resolved kind with no dimension renderer', () => {
    spies.computeConstraintRender.mockReturnValue({ kind: 'other' })
    const { container } = renderPreview()

    expect(container.firstChild).toBeNull()
  })

  it('defaults the synthesised value to 0 when the natural value cannot resolve', () => {
    spies.computeNaturalDimensionValue.mockReturnValue(null)
    renderPreview()

    const constraint = spies.computeConstraintRender.mock.calls[0][0] as { value: number }
    expect(constraint.value).toBe(0)
  })

  it('tracks the cursor by attaching the anchor-relative pos to the constraint', () => {
    spies.resolveDimension.mockReturnValue({ constraintKind: 'point_distance' })
    spies.dimensionTargets.mockReturnValue(['entity:S1:L1', 'entity:S1:L2'])
    spies.resolveDimPoints.mockReturnValue([[0, 0], [10, 0]])
    spies.computeAnchorRelativePos.mockReturnValue([3, 4])
    spies.computeConstraintRender.mockReturnValue({ kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 })
    useSketchEditorStore.setState({ dimensionCursorWorld: [5, 5] })
    renderPreview()

    const constraint = spies.computeConstraintRender.mock.calls[0][0] as { pos?: [number, number] }
    expect(constraint.pos).toEqual([3, 4])
  })
})

describe('DimensionPreview point_distance mode switching', () => {
  function renderPointDistance(cursor: [number, number]) {
    spies.resolveDimension.mockReturnValue({ constraintKind: 'point_distance' })
    spies.dimensionTargets.mockReturnValue(['entity:S1:L1', 'entity:S1:L2'])
    spies.resolveDimPoints.mockReturnValue([[0, 0], [10, 0]])
    spies.computeConstraintRender.mockReturnValue({ kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 })
    useSketchEditorStore.setState({ dimensionCursorWorld: cursor })
    renderPreview()
    const call = spies.computeConstraintRender.mock.calls.at(-1)![0] as { kind: string }
    return call
  }

  it('chooses the vertical (X) axis dim when the cursor is above the anchor', () => {
    expect(renderPointDistance([5, 10]).kind).toBe('point_distance_x')
  })

  it('chooses the horizontal (Y) axis dim when the cursor is to the right of the anchor', () => {
    expect(renderPointDistance([20, 0]).kind).toBe('point_distance_y')
  })

  it('keeps the euclidean kind when the cursor sits on the anchor', () => {
    expect(renderPointDistance([5, 0]).kind).toBe('point_distance')
  })
})
