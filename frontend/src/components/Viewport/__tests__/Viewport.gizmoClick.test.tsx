import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import Viewport from '@/components/Viewport'

// The direct regression pin for "gizmo click broken / viewport no longer turns".
// Same harness as Viewport.pointerLeave.test.tsx but with the real CubeGizmo in
// the tree (not mocked), so a press on its overlay canvas exercises the
// stop-propagation guard that keeps the pane from opening a gesture from under
// the widget. The pane's setPointerCapture spy is the case that fails on
// ddd14786 and passes after the deferred-capture fix.

const rubberBand = vi.hoisted(() => ({
  onPointerDown: vi.fn(),
  onPointerMove: vi.fn(),
  onPointerCancel: vi.fn(),
}))

vi.mock('@/components/Viewport/useRubberBandSelect', () => ({
  useRubberBandSelect: () => ({
    state: { dragging: false, rect: null, isDraggingRef: { current: false } },
    onPointerDown: (...args: unknown[]) => { rubberBand.onPointerDown(...args); return true },
    onPointerMove: (...args: unknown[]) => rubberBand.onPointerMove(...args),
    onPointerUp: () => {},
    onPointerCancel: (...args: unknown[]) => { rubberBand.onPointerCancel(...args) },
  }),
}))

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div data-testid="canvas">{children}</div>,
  useFrame: () => {},
  useThree: () => ({ camera: {}, gl: {}, scene: {} }),
}))

vi.mock('@react-three/drei', () => ({
  OrthographicCamera: () => <div data-testid="ortho-camera" />,
  Line: () => <div data-testid="line" />,
  Text: () => <div data-testid="text" />,
  Environment: () => null,
}))

vi.mock('@/components/Geometry3D', () => ({ default: () => <div data-testid="geometry-3d" />, __esModule: true }))
vi.mock('@/components/Geometry3D/Body3D', () => ({ default: () => <div data-testid="body-3d" />, __esModule: true }))
vi.mock('@/components/Geometry3D/PreviewEdgeOverlay', () => ({ default: () => <div data-testid="preview-edge-overlay" />, __esModule: true }))
// CubeGizmo is intentionally NOT mocked here.
vi.mock('@/components/dialogs/ContextMenuDialog', () => ({ default: () => <div data-testid="context-menu" />, __esModule: true }))
vi.mock('@/components/Viewport/OriginMarker', () => ({ default: () => <div data-testid="origin-marker" />, __esModule: true }))
vi.mock('@/components/Viewport/ReferencePlane', () => ({ default: () => <div data-testid="reference-plane" />, __esModule: true }))
vi.mock('@/components/Viewport/SceneController', () => ({ default: () => <div data-testid="scene-controller" />, __esModule: true }))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1.0, ENV_MAP_INTENSITY: 1.0, __esModule: true }))
vi.mock('@/components/Viewport/UserDefinedPlane', () => ({ default: () => <div data-testid="user-defined-plane" />, __esModule: true }))

if (typeof window.PointerEvent !== 'function') {
  window.PointerEvent = class PointerEventStub extends MouseEvent {
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      Object.defineProperty(this, 'isPrimary', { value: init.isPrimary ?? false, enumerable: true })
      Object.defineProperty(this, 'pointerId', { value: init.pointerId ?? 0, enumerable: true })
      Object.defineProperty(this, 'pointerType', { value: init.pointerType ?? '', enumerable: true })
    }
  } as unknown as typeof PointerEvent
}

const htmlProto = HTMLElement.prototype as unknown as Record<string, (pointerId: number) => unknown>
htmlProto.setPointerCapture = () => {}
htmlProto.releasePointerCapture = () => {}
htmlProto.hasPointerCapture = () => false

beforeEach(() => {
  rubberBand.onPointerDown.mockClear()
  rubberBand.onPointerMove.mockClear()
  rubberBand.onPointerCancel.mockClear()
  usePartEditorStore.setState({
    features: [],
    bodies: {},
    pickBodies: {},
    ghostMode: false,
    rollbackPosition: null,
    visibleFeatures: new Set(),
    visibleBodies: new Set(),
    solveResults: {},
    otherSketches: {},
    partColors: {},
    partStyle: {},
    activeSketchFeatureId: null,
    doc: null,
  })
  useSketchEditorStore.setState({
    activeTool: null,
    normalSelection: new Set(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
    hoveredVertexId: null,
    hoveredConstraintEntityIds: new Set(),
    contextMenu: null,
  })
})

describe('gizmo press ownership', () => {
  it('a press on the cube gizmo never opens a rubber band', () => {
    const { container } = render(<Viewport />)
    const gizmo = container.querySelector('canvas') as Element
    const pane = container.firstChild as Element

    fireEvent.pointerDown(gizmo, { button: 0, pointerId: 1, isPrimary: true })
    expect(rubberBand.onPointerDown).not.toHaveBeenCalled()
    // Sanity: the press really reached an element below the pane.
    expect(gizmo).not.toBe(pane)
  })

  it('a press on the cube gizmo never takes pointer capture on the pane', () => {
    const { container } = render(<Viewport />)
    const gizmo = container.querySelector('canvas') as Element
    const pane = container.firstChild as Element
    const set = vi.fn()
    ;(pane as HTMLElement).setPointerCapture = set
    ;(pane as HTMLElement).hasPointerCapture = vi.fn(() => false)

    fireEvent.pointerDown(gizmo, { button: 0, pointerId: 1, isPrimary: true })
    expect(set).not.toHaveBeenCalled()
  })

  it('a press on the render surface still opens a rubber band', () => {
    const { container } = render(<Viewport />)
    const surface = container.querySelector('[data-testid="canvas"]') as Element

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, isPrimary: true })
    expect(rubberBand.onPointerDown).toHaveBeenCalledTimes(1)
  })

  it('a gizmo click does not clear the normal selection', () => {
    useSketchEditorStore.getState().toggleNormalSelection('sk1/keep')
    const { container } = render(<Viewport />)
    const gizmo = container.querySelector('canvas') as Element

    fireEvent.click(gizmo, { clientX: 70, clientY: 70 })
    expect(useSketchEditorStore.getState().normalSelection.has('sk1/keep')).toBe(true)
  })
})
