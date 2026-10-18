import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { createRef } from 'react'
import type * as THREE from 'three'
import Viewport, { type ViewportHandle } from '@/components/Viewport'
import { RenderOnce } from '@/components/Viewport/RenderOnChange'
import { editorState } from '@/stores/editorState'
import { usePartEditorStore } from '@/stores/partEditorStore'

// The demand-mode wiring of the part Viewport: the Canvas is asked for frames
// on demand (`frameloop="demand"`), an idle tree draws nothing, and the camera
// paths that move the camera outside React (fit, align, the orientation cube's
// snap) reach the Canvas's own invalidate through the ref RenderOnChange
// publishes. Which store changes ask for frames is the policy half, pinned
// against the real stores in sceneInvalidation.test.ts.

interface SceneControllerProps {
  cameraRef: { current: THREE.Camera | null }
}

const h = vi.hoisted(() => ({
  invalidate: vi.fn(),
  canvasProps: null as Record<string, unknown> | null,
  sceneControllerProps: null as SceneControllerProps | null,
  gizmoProps: null as { onRequestRender?: () => void } | null,
  contextCanvas: null as HTMLCanvasElement | null,
}))

vi.mock('@react-three/fiber', () => {
  const domElement = document.createElement('canvas')
  h.contextCanvas = domElement
  // One stable state object for the module's life, like the real store: the
  // heartbeat's effects key off `gl` and `invalidate` identity.
  const state = {
    camera: {},
    gl: { domElement },
    scene: {},
    invalidate: h.invalidate,
    size: { width: 0, height: 0 },
  }
  return {
    Canvas: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => {
      h.canvasProps = props
      return <div data-testid="canvas">{children}</div>
    },
    useFrame: () => {},
    useThree: (selector?: (state: Record<string, unknown>) => unknown) => (selector ? selector(state) : state),
  }
})

vi.mock('@react-three/drei', () => ({
  OrthographicCamera: () => null,
  Line: () => null,
  Text: () => null,
  Environment: () => null,
}))

vi.mock('../../Geometry3D', () => ({ default: () => null, __esModule: true }))
vi.mock('../../Geometry3D/Body3D', () => ({ default: () => null, __esModule: true }))
vi.mock('../../Geometry3D/PreviewEdgeOverlay', () => ({ default: () => null, __esModule: true }))

vi.mock('../../misc/CubeGizmo', () => ({
  CubeGizmoCanvas: (props: { onRequestRender?: () => void }) => {
    h.gizmoProps = props
    return null
  },
}))

vi.mock('../SceneController', () => ({
  default: (props: SceneControllerProps) => {
    h.sceneControllerProps = props
    return null
  },
  __esModule: true,
}))

vi.mock('../EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1, ENV_MAP_INTENSITY: 0, __esModule: true }))
vi.mock('../OriginMarker', () => ({ default: () => null, __esModule: true }))
vi.mock('../ReferencePlane', () => ({ default: () => null, __esModule: true }))
vi.mock('../UserDefinedPlane', () => ({ default: () => null, __esModule: true }))
vi.mock('../IdDebugOverlay', () => ({ default: () => null, __esModule: true }))
vi.mock('../IdPickReadout', () => ({ default: () => null, __esModule: true }))
vi.mock('../../dialogs/ContextMenuDialog', () => ({ default: () => null, __esModule: true }))

// A fit succeeds here so its frame request is the thing under test, never the
// camera math (cameraController.test.ts owns that).
vi.mock('@/components/Viewport/cameraController', () => ({
  fitToContent: vi.fn(() => true),
  alignToPlane: vi.fn(),
  alignToFace: vi.fn(),
  traceCamera: vi.fn(),
}))

function mountViewport() {
  const ref = createRef<ViewportHandle>()
  const view = render(<Viewport ref={ref} />)
  return { ref, view }
}

// Stand in for the Canvas-owned camera appearing; SceneController is mocked,
// so the test publishes it through the captured props.
function publishCamera() {
  act(() => { h.sceneControllerProps!.cameraRef.current = {} as THREE.Camera })
}

beforeEach(() => {
  h.invalidate.mockClear()
  h.canvasProps = null
  h.sceneControllerProps = null
  h.gizmoProps = null
  usePartEditorStore.setState({
    features: [],
    bodies: {},
    pickBodies: {},
    visibleFeatures: new Set(),
    visibleBodies: new Set(),
    solveResults: {},
    otherSketches: {},
    doc: null,
    isRebuilding: false,
  })
  editorState.setState({
    ghostMode: false,
    rollbackPosition: null,
    partColors: {},
    partStyle: {},
    activeSketchFeatureId: null,
    editingFeatureId: null,
  })
})

describe('Viewport demand rendering', () => {
  it('renders its Canvas on demand, not once per display refresh, and draws its first frame on mount', () => {
    // The whole point: an idle viewport must stop feeding the frosted cards'
    // backdrop-filter a new canvas every frame; the mount frame is what draws
    // the initial, otherwise-empty scene.
    mountViewport()
    expect(h.canvasProps?.frameloop).toBe('demand')
    expect(h.invalidate).toHaveBeenCalled()
  })

  it('requests a frame when a store that feeds the scene changes', () => {
    mountViewport()
    h.invalidate.mockClear()

    act(() => { usePartEditorStore.setState({ isRebuilding: true }) })

    expect(h.invalidate).toHaveBeenCalled()

    act(() => { usePartEditorStore.setState({ isRebuilding: false }) })
  })

  it('adds no frame of its own when the tree merely re-renders', () => {
    // The heartbeat subscribes to stores, not to renders. A prop change does
    // request a frame through the reconciler's own instance invalidation,
    // which the mocked Canvas cannot model, so this pins exactly what the
    // heartbeat adds on top of it.
    const { view } = mountViewport()
    h.invalidate.mockClear()

    view.rerender(<Viewport />)

    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('stops requesting frames after unmount', () => {
    const { view } = mountViewport()
    view.unmount()
    h.invalidate.mockClear()

    act(() => { usePartEditorStore.setState({ isRebuilding: true }) })

    expect(h.invalidate).not.toHaveBeenCalled()

    act(() => { usePartEditorStore.setState({ isRebuilding: false }) })
  })

  it('requests a frame when the GL context comes back', () => {
    // A restored context leaves the canvas blank and no store changed, so on
    // demand nothing would repaint it until the next unrelated interaction.
    mountViewport()
    h.invalidate.mockClear()

    act(() => { h.contextCanvas!.dispatchEvent(new Event('webglcontextrestored')) })

    expect(h.invalidate).toHaveBeenCalled()
  })

  it('RenderOnce asks for a frame on mount, which is how the settled HDR reaches the canvas', () => {
    // drei's Environment applies scene.environment from a layout effect and
    // creates no R3F instance, so the component mounted beside it inside the
    // Suspense boundary is the only thing asking for the frame that shows it.
    h.invalidate.mockClear()

    render(<RenderOnce />)

    expect(h.invalidate).toHaveBeenCalled()
  })

  it('requests a frame after a fit moves the camera outside React', () => {
    const { ref } = mountViewport()
    publishCamera()
    h.invalidate.mockClear()

    act(() => { ref.current!.autoZoomToFit() })

    expect(h.invalidate).toHaveBeenCalled()
  })

  it('requests a frame after a plane or face alignment moves the camera', () => {
    const { ref } = mountViewport()
    publishCamera()
    h.invalidate.mockClear()

    act(() => { ref.current!.alignCameraToPlane('builtin_plane_front') })
    act(() => { ref.current!.alignCameraToFace([0, 0, 1], [0, 0, 0]) })

    expect(h.invalidate).toHaveBeenCalledTimes(2)
  })

  it('gives the orientation cube a way to request its own frame', () => {
    mountViewport()
    h.invalidate.mockClear()

    act(() => { h.gizmoProps!.onRequestRender!() })

    expect(h.invalidate).toHaveBeenCalled()
  })
})
