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
  onPointerCancel: vi.fn(),
}))

vi.mock('@/components/Viewport/useRubberBandSelect', () => ({
  useRubberBandSelect: () => ({
    state: { dragging: false, rect: null, isDraggingRef: { current: false } },
    onPointerDown: (...args: unknown[]) => { rubberBand.onPointerDown(...args); return true },
    onPointerMove: () => {},
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

// jsdom has no notion of an active pointer, so its setPointerCapture throws
// InvalidStateError from inside the listener. The Viewport only needs the
// capture calls to exist; per-test spies below shadow these where asserted.
const htmlProto = HTMLElement.prototype as unknown as Record<string, (pointerId: number) => unknown>
htmlProto.setPointerCapture = () => {}
htmlProto.releasePointerCapture = () => {}
htmlProto.hasPointerCapture = () => false

beforeEach(() => {
  rubberBand.onPointerDown.mockClear()
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

// Instance-level stubs shadow whatever pointer-capture support the jsdom
// element class has, so the assertions observe exactly what Viewport calls.
function captureStubs(el: Element): {
  set: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  const set = vi.fn()
  const release = vi.fn()
  ;(el as HTMLElement).setPointerCapture = set
  ;(el as HTMLElement).releasePointerCapture = release
  ;(el as HTMLElement).hasPointerCapture = vi.fn(() => false)
  return { set, release }
}

describe('Viewport pointer capture for box drags', () => {
  it('captures the pointer when a rubber-band starts so an off-pane release still lands', () => {
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    const { set } = captureStubs(el)

    // A right-button press opens no band and must not capture.
    fireEvent.pointerDown(el, { button: 2, isPrimary: true })
    expect(set).not.toHaveBeenCalled()

    fireEvent.pointerDown(el, { button: 0, isPrimary: true })
    expect(set).toHaveBeenCalledWith(0)
  })

  it('pointercancel drops the band and the pending click gesture', () => {
    const onRightClick = vi.fn()
    const { container } = render(<Viewport onRightClick={onRightClick} />)
    const el = container.firstChild as Element
    captureStubs(el)

    fireEvent.pointerDown(el, { button: 0, isPrimary: true })
    fireEvent.pointerCancel(el)
    expect(rubberBand.onPointerCancel).toHaveBeenCalledTimes(1)

    // The cancelled gesture owns nothing: its release must neither reopen the
    // context menu nor pair with the gesture that never finished.
    fireEvent.pointerUp(el, { button: 2, isPrimary: true })
    expect(onRightClick).not.toHaveBeenCalled()
  })

  it('a completed right-click still opens the context menu', () => {
    const onRightClick = vi.fn()
    const { container } = render(<Viewport onRightClick={onRightClick} />)
    const el = container.firstChild as Element
    captureStubs(el)

    fireEvent.pointerDown(el, { button: 2, isPrimary: true, clientX: 12, clientY: 34 })
    fireEvent.pointerUp(el, { button: 2, isPrimary: true, clientX: 12, clientY: 34 })
    expect(onRightClick).toHaveBeenCalledWith([12, 34])
  })
})
