import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import Viewport from '@/components/Viewport'

// Spy the rubber-band hook so the test can observe whether the hasHover gate
// lets a pointer-down reach the box-drag start. The real hook needs a live
// WebGL renderer the jsdom test env does not have.
const rubberBand = vi.hoisted(() => ({
  onPointerDown: vi.fn(),
}))

vi.mock('@/components/Viewport/useRubberBandSelect', () => ({
  useRubberBandSelect: () => ({
    state: { dragging: false, rect: null, isDraggingRef: { current: false } },
    onPointerDown: (...args: unknown[]) => { rubberBand.onPointerDown(...args); return true },
    onPointerMove: () => {},
    onPointerUp: () => {},
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
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => <div data-testid="cube-gizmo" /> }))
vi.mock('@/components/dialogs/ContextMenuDialog', () => ({ default: () => <div data-testid="context-menu" />, __esModule: true }))
vi.mock('@/components/Viewport/OriginMarker', () => ({ default: () => <div data-testid="origin-marker" />, __esModule: true }))
vi.mock('@/components/Viewport/ReferencePlane', () => ({ default: () => <div data-testid="reference-plane" />, __esModule: true }))
vi.mock('@/components/Viewport/SceneController', () => ({ default: () => <div data-testid="scene-controller" />, __esModule: true }))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1.0, ENV_MAP_INTENSITY: 1.0, __esModule: true }))
vi.mock('@/components/Viewport/UserDefinedPlane', () => ({ default: () => <div data-testid="user-defined-plane" />, __esModule: true }))

// jsdom has no PointerEvent constructor, so fireEvent.pointer* would degrade to
// a plain Event and drop button/isPrimary. Install a minimal PointerEvent so the
// Viewport's isPrimary gate behaves like the browser. Scoped to this file only
// (vitest isolates modules per file).
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

beforeEach(() => {
  rubberBand.onPointerDown.mockClear()
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

describe('Viewport pointer-leave hover clear', () => {
  it('clears hoveredSelectionId and hoveredPickKey when the pointer leaves', () => {
    const { container } = render(<Viewport />)
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId('face:sk1:?3;@sk1abc')
    s.setHoveredPickKey('sk1abc#1')

    fireEvent.pointerOut(container.firstChild as Element, { relatedTarget: null })

    const after = useSketchEditorStore.getState()
    expect(after.hoveredSelectionId).toBeNull()
    expect(after.hoveredPickKey).toBeNull()
  })

  it('a stale hover no longer blocks a rubber-band start after the pointer leaves', () => {
    const { container } = render(<Viewport />)
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId('face:sk1:?3;@sk1abc')

    // The stale hover stands until the pointer leaves, so a press on empty
    // space is swallowed by the hasHover gate and never reaches the box-drag
    // start.
    fireEvent.pointerDown(container.firstChild as Element, { button: 0, isPrimary: true })
    expect(rubberBand.onPointerDown).not.toHaveBeenCalled()

    // Leaving tears the hover down, so the same press now passes the gate.
    fireEvent.pointerOut(container.firstChild as Element, { relatedTarget: null })
    fireEvent.pointerDown(container.firstChild as Element, { button: 0, isPrimary: true })
    expect(rubberBand.onPointerDown).toHaveBeenCalledTimes(1)
  })
})
