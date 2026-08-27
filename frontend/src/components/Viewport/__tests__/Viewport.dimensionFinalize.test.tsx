import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import Viewport from '@/components/Viewport'
import { clearStaleBandClickConsumed } from '@/components/Viewport/idDispatch/bandClickGuard'
import { getLivePipeline } from '@/picking/IdPipelineContext'

// A real (jsdom) canvas so the id-buffer dispatcher attaches its click listener
// to a live element. The Canvas mock hands this to the Viewport via onCreated.
const fakeCanvas = document.createElement('canvas')
fakeCanvas.width = 800
fakeCanvas.height = 600
fakeCanvas.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} },
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children?: React.ReactNode; onCreated?: (s: unknown) => void }) => {
    if (onCreated) onCreated({ gl: { domElement: fakeCanvas, readRenderTargetPixels: () => {} }, scene: {} })
    return <div data-testid="canvas">{children}</div>
  },
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

function captureStubs(el: Element): void {
  ;(el as HTMLElement).setPointerCapture = vi.fn()
  ;(el as HTMLElement).releasePointerCapture = vi.fn()
  ;(el as HTMLElement).hasPointerCapture = vi.fn(() => false)
}

beforeEach(() => {
  clearStaleBandClickConsumed()
  usePartEditorStore.setState({
    features: [], bodies: {}, pickBodies: {}, ghostMode: false,
    rollbackPosition: null, visibleFeatures: new Set(), visibleBodies: new Set(),
    solveResults: {}, otherSketches: {}, partColors: {}, partStyle: {},
    activeSketchFeatureId: null, doc: null,
  })
  useSketchEditorStore.setState({
    activeTool: 'dimension',
    activeFeatureId: 'feat1',
    dimensionPicks: [{ isVertex: false, target: 'entity:feat1:l1' }, { isVertex: false, target: 'entity:feat1:l2' }],
    normalSelection: new Set(),
    hoveredSelectionId: null, hoveredPickKey: null, hoveredVertexId: null,
    hoveredConstraintEntityIds: new Set(), contextMenu: null,
  })
})

describe('dimension finalize is not swallowed by the rubber band', () => {
  it('reaches finalizeDimensionPlacement when the placement click is a small drag', () => {
    const spy = vi.spyOn(useSketchEditorStore.getState(), 'finalizeDimensionPlacement')
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    captureStubs(el)
    // The test paints no real geometry, so the id buffer is dirty on mount; a
    // dirty resolve would read as a stale miss and refuse to finalise. The real
    // app re-renders the buffer every frame, so pin the clean state here.
    getLivePipeline()?.target.markClean()

    // A left press on empty space, then a small drag (positioning the preview
    // label), then release and the trailing click. The drag must NOT open a box
    // select that swallows the finalizing click.
    act(() => {
      fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 })
    })
    act(() => {
      fireEvent.pointerMove(el, { button: 0, isPrimary: true, pointerType: 'mouse', buttons: 1, clientX: 130, clientY: 140 })
    })
    act(() => {
      fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 130, clientY: 140 })
    })

    // The trailing click is dispatched on the canvas the dispatcher listens to.
    act(() => {
      fireEvent.click(fakeCanvas, { button: 0, clientX: 130, clientY: 140 })
    })

    expect(spy).toHaveBeenCalledWith([130, 140])
  })
})
