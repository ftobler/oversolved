import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import Viewport from '@/components/Viewport'
import { clearStaleBandClickConsumed } from '@/components/Viewport/idDispatch/bandClickGuard'
import { shouldClearSelectionOnBackplaneClick } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { getLivePipeline, setLivePipeline } from '@/picking/IdPipelineContext'
import { IdPipeline, FACE_LAYER_NAME } from '@/picking'

// Capture the miss handler the way R3F would call it after a click that hit no
// geometry, so the test can drive the real deselect path.
const missedFn = vi.hoisted(() => ({ current: null as (() => void) | null }))

// A real (jsdom) canvas so the id-buffer dispatcher attaches its click listener
// to a live element. The Canvas mock hands this to the Viewport via onCreated.
const fakeCanvas = document.createElement('canvas')
fakeCanvas.width = 800
fakeCanvas.height = 600
fakeCanvas.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} },
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated, onPointerMissed }: {
    children?: React.ReactNode
    onCreated?: (s: unknown) => void
    onPointerMissed?: () => void
  }) => {
    missedFn.current = onPointerMissed ?? null
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

function captureStubs(el: Element): { set: ReturnType<typeof vi.fn> } {
  const set = vi.fn()
  ;(el as HTMLElement).setPointerCapture = set
  ;(el as HTMLElement).releasePointerCapture = vi.fn()
  ;(el as HTMLElement).hasPointerCapture = vi.fn(() => false)
  return { set }
}

function seedSelection(key: string): void {
  useSketchEditorStore.setState({ normalSelection: new Set([key]) })
}

describe('part editor empty-space click clears the selection', () => {
  beforeEach(() => {
    clearStaleBandClickConsumed()
    usePartEditorStore.setState({
      features: [], bodies: {}, pickBodies: {}, ghostMode: false,
      rollbackPosition: null, visibleFeatures: new Set(), visibleBodies: new Set(),
      solveResults: {}, otherSketches: {}, partColors: {}, partStyle: {},
      activeSketchFeatureId: null, doc: null,
    })
    useSketchEditorStore.setState({
      activeTool: null,
      activeFeatureId: null,
      dimensionPicks: [],
      normalSelection: new Set(),
      hoveredSelectionId: null, hoveredPickKey: null, hoveredVertexId: null,
      hoveredConstraintEntityIds: new Set(), contextMenu: null,
    })
    setLivePipeline(null)
    missedFn.current = null
  })

  it('a stationary left click on empty space clears the normal selection', () => {
    seedSelection('face:body1:0')
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    captureStubs(el)
    // The real picking driver mounts a live pipeline whose buffer is dirty in
    // jsdom (never rendered). A dirty resolve would read as a stale miss, not
    // empty space; the real app re-renders every frame, so pin clean here.
    act(() => { getLivePipeline()?.target.markClean() })

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.click(fakeCanvas, { button: 0, clientX: 100, clientY: 100 }) })

    act(() => { missedFn.current?.() })
    expect(missedFn.current).toBeTruthy()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('a right-button gesture does not clear the selection', () => {
    seedSelection('face:body1:0')
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    captureStubs(el)

    act(() => { fireEvent.pointerDown(el, { button: 2, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.pointerUp(el, { button: 2, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { missedFn.current?.() })

    expect([...useSketchEditorStore.getState().normalSelection]).toEqual(['face:body1:0'])
  })

  it('a left drag of 30px does not clear the selection', () => {
    seedSelection('face:body1:0')
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    captureStubs(el)
    act(() => { getLivePipeline()?.target.markClean() })

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.pointerMove(el, { button: 0, isPrimary: true, pointerType: 'mouse', buttons: 1, clientX: 130, clientY: 130 }) })
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 130, clientY: 130 }) })
    act(() => { fireEvent.click(fakeCanvas, { button: 0, clientX: 130, clientY: 130 }) })

    act(() => { missedFn.current?.() })
    expect([...useSketchEditorStore.getState().normalSelection]).toEqual(['face:body1:0'])
  })

  it('a click that the id dispatcher consumed does not clear the selection', () => {
    seedSelection('face:body1:0')
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    captureStubs(el)
    // Drive the live pipeline the picking driver mounted to resolve a face, so
    // the id-buffer dispatcher consumes the click (toggling face:body2:0 in).
    const pipeline = getLivePipeline() as IdPipeline | null
    act(() => {
      if (pipeline) {
        pipeline.target.markClean()
        pipeline.resolveSync = () => ({
          id: 1, layer: FACE_LAYER_NAME, entityKey: 'face:body2:0', distancePx: 0,
        }) as unknown as ReturnType<IdPipeline['resolveSync']>
      }
    })

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.click(fakeCanvas, { button: 0, clientX: 100, clientY: 100 }) })

    act(() => { missedFn.current?.() })
    expect(useSketchEditorStore.getState().normalSelection.has('face:body1:0')).toBe(true)
  })

  // Inside a sketch R3F never reports a miss: the DrawPlane backplane covers
  // the whole plane, so it is always hit and the clear runs off the flags
  // handlePointerUp publishes instead of the live refs onPointerMissed reads.
  // A stationary press on empty space arms the rubber band without opening a
  // box; publishing that as "a sweep owns this click" made the backplane refuse
  // every clear, and background deselection was dead in sketch edit mode only.
  it('a stationary left click inside a sketch clears through the backplane path', () => {
    useSketchEditorStore.setState({ activeFeatureId: 'sk1', activeTool: null })
    seedSelection('entity:sk1:e0')
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    captureStubs(el)
    act(() => { getLivePipeline()?.target.markClean() })

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.click(fakeCanvas, { button: 0, clientX: 100, clientY: 100 }) })

    expect(shouldClearSelectionOnBackplaneClick()).toBe(true)
  })

  it('the pane holds no pointer capture for a press that never opened a box', () => {
    const { container } = render(<Viewport />)
    const el = container.firstChild as Element
    const { set } = captureStubs(el)

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    expect(set).not.toHaveBeenCalled()
  })

  it('a non-primary pointercancel does not wipe the primary gesture in flight', () => {
    // A stray secondary-pointer cancel used to reset the shared tracker, so the
    // primary's later release read hadDown === false and the right-click (and
    // the deselect flags) were silently dropped.
    const onRightClick = vi.fn()
    const { container } = render(<Viewport onRightClick={onRightClick} />)
    const el = container.firstChild as Element
    captureStubs(el)

    act(() => { fireEvent.pointerDown(el, { button: 2, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100 }) })
    act(() => { fireEvent.pointerCancel(el, { isPrimary: false, pointerId: 2 }) })
    act(() => { fireEvent.pointerUp(el, { button: 2, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100 }) })

    expect(onRightClick).toHaveBeenCalledWith([100, 100])
  })
})
