import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { Sketch, Constraints } from '@/types/cad'
import type { DimLabelDrag, VertexOrEdgeDrag } from '@/stores/sketchEditorTypes'

/**
 * The dimension overlays draw from the last cold solve's render blocks, not from
 * the sketch the viewport is showing. While a drag preview (or the held preview
 * after pointer-up) moves the geometry, those blocks are pre-drag: the extension
 * lines, arrows and arc stay where the geometry used to be. This suite drives
 * Geometry3D's own staleness gate through the drag, the held window and the cold
 * solve, and pins that the dimensions are hidden for exactly that window.
 *
 * The child renderers are stubbed: the subject is the gate and the display
 * sketch it is derived from, not the three.js drawing.
 */

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {} }),
  useFrame: () => {},
}))

vi.mock('@react-three/drei', () => ({
  Html: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div data-testid="html-wrapper" style={style}>{children}</div>
  ),
  Line: () => null,
}))

vi.mock('@/components/Geometry3D/VertexDots', () => ({ VertexDot: () => null, VertexHighlight: () => null }))
vi.mock('@/components/Geometry3D/EntityLines', () => ({ EntityLines: () => null }))
vi.mock('@/components/Geometry3D/Surfaces', () => ({ TopologySurfaces: () => null }))
vi.mock('@/components/Geometry3D/Dragging', () => ({ DragPlane: () => null, DragSnapIndicator: () => null }))
vi.mock('@/components/Geometry3D/InferredContactMarkers', () => ({ InferredContactMarkers: () => null }))
vi.mock('@/components/Geometry3D/Drawing', () => ({ DrawPreview: () => null, DrawPlane: () => null }))
vi.mock('@/components/Geometry3D/dimensions/Preview', () => ({ DimensionPreview: () => null }))
vi.mock('@/hooks/useWasmDragSolve', () => ({
  useWasmDragSolve: () => ({ sketch: null, engaged: false }),
}))
// The drag test never runs a cold solve; the stub also satisfies test-setup's
// per-test topology write, which is a no-op without a kernel.
vi.mock('@/kernel/features/sketch', () => ({
  resolvedKindsOfSketch: () => ({}),
  setSketchTopology: () => {},
}))
vi.mock('@/picking', () => ({
  useSketchIdRegistration: () => {},
  useSketchSurfaceIdRegistration: () => {},
  publishProbeSketchPlane: () => {},
}))

vi.mock('@/components/Geometry3D/dimensions/Linear', () => ({
  LinearDimension: ({ cid, dim }: { cid: string; dim: { value: number } }) => (
    <div data-testid={`linear-dim-${cid}`} data-value={String(dim.value)} />
  ),
}))
vi.mock('@/components/Geometry3D/dimensions/Radial', () => ({
  RadiusDimension: () => null,
  DiameterDimension: () => null,
}))
vi.mock('@/components/Geometry3D/dimensions/Angle', () => ({ AngleDimension: () => null }))

vi.mock('@/utils/geometry/sketchHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/geometry/sketchHelpers')>()
  return {
    ...actual,
    getIconUrl: (kind: string) => (kind.startsWith('symbol_') ? `/icons/${kind}.svg` : undefined),
  }
})

vi.mock('@/utils/geometry/drawGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/geometry/drawGeometry')>()
  return { ...actual, findEntitiesAtPoint: () => ['l1'] }
})

import Geometry3D from '@/components/Geometry3D'
import { useEditorState } from '@/hooks/useEditorState'
import { useSketchUiStore } from '@/stores/sketchEditorStore'

const featureId = 'S1'

const solved: Sketch = {
  l1: { kind: 'lineSegment', start: [0, 0], end: [10, 0] } as Sketch[string],
}

function dimensions(value: number): Constraints {
  return {
    d1: { render: { kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value }, residual: 0 } as Constraints[string],
    d2: { render: { kind: 'dim_linear', p1: [0, 5], p2: [10, 5], normal: [0, 1], value: value + 5 }, residual: 0 } as Constraints[string],
  }
}

function withSymbol(constraints: Constraints): Constraints {
  return {
    ...constraints,
    c1: { render: { kind: 'symbol_horizontal', at: [5, 0], entities: ['l1'] }, residual: 0 } as Constraints[string],
  }
}

function edgeDrag(): VertexOrEdgeDrag {
  return {
    type: 'edge', vertexId: 'l1', featureId, entityId: 'l1', vertexKey: 'edge',
    startWorld: [0, 0], currentWorld: [5, 0], startClient: [0, 0],
  }
}

function dimLabelDrag(): DimLabelDrag {
  return {
    type: 'dim_label', constraintId: 'd1', featureId,
    anchorWorld: [5, 1], startWorld: [5, 1], currentWorld: [6, 2],
  }
}

function renderGeometry(constraints: Constraints) {
  return render(
    <Geometry3D
      featureId={featureId}
      solved={solved}
      constraints={constraints}
      activeFeatureId={featureId}
    />,
  )
}

beforeEach(() => {
  useSketchUiStore.setState({ showConstraintTiles: true })
  useEditorState.setState({ drag: null, dragCommitted: false, activeFeatureId: featureId })
})

describe('dimensions while the sketch geometry is stale', () => {
  it('hides them from the edge drag through the held window, then shows them at the cold solve', () => {
    const view = renderGeometry(dimensions(10))
    expect(view.queryByTestId('linear-dim-d1')).not.toBeNull()
    expect(view.queryByTestId('linear-dim-d2')).not.toBeNull()

    act(() => { useEditorState.getState().setDrag(edgeDrag(), false) })
    expect(view.queryByTestId('linear-dim-d1')).toBeNull()
    expect(view.queryByTestId('linear-dim-d2')).toBeNull()

    // Pointer-up: the commit dispatched a mutation, so the preview is frozen and
    // shown until the solve lands.
    act(() => { useEditorState.getState().setDrag(null, true) })
    expect(view.queryByTestId('linear-dim-d1')).toBeNull()

    // The cold solve arrives as a fresh sketch identity, with re-derived
    // render blocks.
    const postSolve = structuredClone(solved)
    view.rerender(
      <Geometry3D
        featureId={featureId}
        solved={postSolve}
        constraints={dimensions(12)}
        activeFeatureId={featureId}
      />,
    )
    expect(view.getByTestId('linear-dim-d1').getAttribute('data-value')).toBe('12')
    expect(view.queryByTestId('linear-dim-d2')).not.toBeNull()
  })

  it('hides the symbol tiles through the held window too', () => {
    const view = renderGeometry(withSymbol(dimensions(10)))
    expect(view.container.querySelector('img')).not.toBeNull()

    act(() => { useEditorState.getState().setDrag(edgeDrag(), false) })
    expect(view.container.querySelector('img')).toBeNull()

    act(() => { useEditorState.getState().setDrag(null, true) })
    expect(view.container.querySelector('img')).toBeNull()

    view.rerender(
      <Geometry3D
        featureId={featureId}
        solved={structuredClone(solved)}
        constraints={withSymbol(dimensions(12))}
        activeFeatureId={featureId}
      />,
    )
    expect(view.container.querySelector('img')).not.toBeNull()
  })

  it('shows the overlays again when a locked drag commits nothing', () => {
    // A fully constrained circle resolves to mode 'locked': DragTool dispatches
    // no mutation, so no fresh solve is coming to replace a frozen preview. The
    // hold must clear and the gate fall back to live, or the dimensions and
    // tiles would stay hidden until the next document edit.
    const view = renderGeometry(withSymbol(dimensions(10)))

    act(() => { useEditorState.getState().setDrag(edgeDrag(), false) })
    expect(view.queryByTestId('linear-dim-d1')).toBeNull()
    expect(view.container.querySelector('img')).toBeNull()

    act(() => { useEditorState.getState().setDrag(null, false) })
    expect(view.queryByTestId('linear-dim-d1')).not.toBeNull()
    expect(view.queryByTestId('linear-dim-d2')).not.toBeNull()
    expect(view.container.querySelector('img')).not.toBeNull()
  })

  it('does not leave the gate stuck when a held drag is dropped by undo or sketch exit', () => {
    // clearDragState is the undo/sketch-exit wipe: it clears the drag and the
    // commit verdict from under an in-flight solve. The undo restore lands a
    // fresh `solved`, which must release the hold; until then the held preview
    // is still the right thing on screen.
    const view = renderGeometry(withSymbol(dimensions(10)))
    act(() => { useEditorState.getState().setDrag(edgeDrag(), false) })
    act(() => { useEditorState.getState().setDrag(null, true) })
    expect(view.queryByTestId('linear-dim-d1')).toBeNull()

    act(() => { useEditorState.getState().clearDragState() })
    expect(view.queryByTestId('linear-dim-d1')).toBeNull()  // still showing the held preview

    // The restore's re-solve arrives as a fresh sketch identity.
    view.rerender(
      <Geometry3D
        featureId={featureId}
        solved={structuredClone(solved)}
        constraints={withSymbol(dimensions(10))}
        activeFeatureId={featureId}
      />,
    )
    expect(view.queryByTestId('linear-dim-d1')).not.toBeNull()
    expect(view.queryByTestId('linear-dim-d2')).not.toBeNull()
    expect(view.container.querySelector('img')).not.toBeNull()
  })

  it('keeps every dimension and tile during a dimension label drag', () => {
    // A label drag repositions a label; it does not move geometry, so nothing
    // derived from the solve is stale and the dragged dimension must stay
    // visible under the cursor.
    const view = renderGeometry(withSymbol(dimensions(10)))

    act(() => { useEditorState.getState().setDrag(dimLabelDrag(), false) })

    expect(view.queryByTestId('linear-dim-d1')).not.toBeNull()
    expect(view.queryByTestId('linear-dim-d2')).not.toBeNull()
    expect(view.container.querySelector('img')).not.toBeNull()
  })
})
