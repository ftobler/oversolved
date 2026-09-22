import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { DragState } from '@/stores/sketchEditorStore'
import { DragSnapIndicator, DragAlignmentIndicator } from '@/components/Geometry3D/Dragging'
import { COLOR_SNAP, COLOR_PREVIEW } from '@/components/Geometry3D/constants'

/**
 * The drag overlays are pure store projections: a snap dot exactly when a snap
 * is live, and an alignment guide only for a vertex drag that has a BOTH a snap
 * point and a kind. The missing-kind guard is the interesting one: a point
 * alone would otherwise draw a guide to nowhere.
 */

const MockDot = vi.fn((_props: Record<string, unknown>) => null)
const MockDashed = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {}, gl: {} }),
}))
vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: (props: Record<string, unknown>) => { MockDot(props); return null },
}))
vi.mock('@/components/Geometry3D/dimensions', () => ({
  DashedLine: (props: Record<string, unknown>) => { MockDashed(props); return null },
}))

function vertexDrag(currentWorld: [number, number]): DragState {
  return {
    type: 'vertex', vertexId: 'entity:S1:L1', featureId: 'S1', entityId: 'L1',
    vertexKey: 'start', startWorld: [0, 0], currentWorld, startClient: [0, 0],
  }
}

beforeEach(() => {
  MockDot.mockClear()
  MockDashed.mockClear()
  useSketchEditorStore.setState({
    drag: null, dragSnap: null, alignmentSnapPoint: null, alignmentSnapKind: null,
  })
})

describe('DragSnapIndicator', () => {
  it('renders nothing without a snap target', () => {
    expect(render(<DragSnapIndicator />).container.firstChild).toBeNull()
  })

  it('renders a snap dot at the target position', () => {
    useSketchEditorStore.setState({
      dragSnap: { kind: 'vertex', position: [3, 4], constraintKind: 'coincident' },
    })
    render(<DragSnapIndicator />)
    expect(MockDot).toHaveBeenCalledWith(expect.objectContaining({ x: 3, y: 4, px: 6, color: COLOR_SNAP }))
  })
})

describe('DragAlignmentIndicator', () => {
  it('renders nothing without a drag', () => {
    useSketchEditorStore.setState({ alignmentSnapPoint: [1, 1], alignmentSnapKind: 'kinda_horizontal' })
    expect(render(<DragAlignmentIndicator />).container.firstChild).toBeNull()
  })

  it('renders nothing for a non-vertex drag', () => {
    useSketchEditorStore.setState({
      drag: { type: 'dim_label', constraintId: 'c1', featureId: 'S1', anchorWorld: [0, 0], startWorld: [0, 0], currentWorld: [1, 1] },
      alignmentSnapPoint: [1, 1], alignmentSnapKind: 'kinda_horizontal',
    })
    expect(render(<DragAlignmentIndicator />).container.firstChild).toBeNull()
  })

  it('renders nothing when the snap kind is missing', () => {
    useSketchEditorStore.setState({ drag: vertexDrag([2, 2]), alignmentSnapPoint: [1, 1] })
    expect(render(<DragAlignmentIndicator />).container.firstChild).toBeNull()
  })

  it('draws a dashed guide from the snap point to the dragged position', () => {
    useSketchEditorStore.setState({
      drag: vertexDrag([2, 2]),
      alignmentSnapPoint: [1, 1],
      alignmentSnapKind: 'kinda_vertical',
    })
    render(<DragAlignmentIndicator />)
    expect(MockDashed).toHaveBeenCalledWith(expect.objectContaining({
      points: [[1, 1, 0], [2, 2, 0]],
      color: COLOR_PREVIEW,
      lineWidth: 1,
    }))
  })
})
