import React, { createRef } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { Feature, BodyResult } from '@/types/cad'
import Viewport, { type ViewportHandle } from '@/components/Viewport'
import * as THREE from 'three'

// Provide a real THREE.OrthographicCamera so autoZoomToFitNow can succeed.
const testCamera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
testCamera.position.set(20, 20, 100)
testCamera.zoom = 200
testCamera.updateProjectionMatrix()
testCamera.updateMatrixWorld()

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useFrame: () => {},
  // domElement is real so SceneController's right-button remap can attach.
  useThree: () => ({ camera: testCamera, gl: { domElement: document.createElement('canvas') }, scene: new THREE.Scene() }),
}))

vi.mock('@react-three/drei', () => ({
  OrthographicCamera: () => null,
  OrbitControls: () => null,
  Line: () => null,
  Text: () => null,
  Environment: () => null,
}))

vi.mock('../../Geometry3D', () => ({ default: () => null, __esModule: true }))
vi.mock('../../Geometry3D/Body3D', () => ({ default: () => null, __esModule: true }))
vi.mock('../../Geometry3D/PreviewEdgeOverlay', () => ({ default: () => null, __esModule: true }))
vi.mock('../../misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('../../dialogs/ContextMenuDialog', () => ({ default: () => null, __esModule: true }))
vi.mock('../OriginMarker', () => ({ default: () => null, __esModule: true }))
vi.mock('../ReferencePlane', () => ({ default: () => null, __esModule: true }))
// SceneController is NOT mocked so it runs and sets cameraRef.current = testCamera.
vi.mock('../EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1.0, ENV_MAP_INTENSITY: 1.0, __esModule: true }))
vi.mock('../UserDefinedPlane', () => ({ default: () => null, __esModule: true }))
vi.mock('../PlaneVisual', () => ({ PlaneSurface: () => null, PlaneLabel: () => null }))
vi.mock('../idDispatch/useIdBufferPointerDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../idDispatch/useIdBufferPointerDispatch')>()
  return { ...actual, useIdBufferPointerDispatch: () => {} }
})
vi.mock('../../../picking/IdPickingDriver', () => ({ default: () => null, __esModule: true }))
vi.mock('../IdDebugOverlay', () => ({ default: () => null, __esModule: true }))

function makeBodyWithVertices(): Record<string, BodyResult> {
  // Provide non-degenerate Float32Array vertices so autoZoomToFitNow can compute a bounding box.
  return {
    body1: {
      id: 'body1',
      created_by: 'ex1',
      modified_by: [],
      mesh: {
        vertices: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
        faces: [],
        face_data: [],
        face_queries: [],
      },
    } as unknown as BodyResult,
  }
}

beforeEach(() => {
  testCamera.zoom = 200
  testCamera.updateProjectionMatrix()

  useSketchEditorStore.setState({
    closeContextMenu: () => {},
    clearNormalSelection: () => {},
    setHoveredSelectionId: () => {},
    showDebugHit: false,
  })
  usePartEditorStore.setState({
    features: [] as Feature[],
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
})

describe('auto-zoom does not fire while editing a sketch', () => {
  it('zooms when bodies arrive with no active sketch feature', async () => {
    const ref = createRef<ViewportHandle>()
    render(<Viewport ref={ref} />)
    const zoomBefore = testCamera.zoom

    ref.current?.autoZoomToFit()

    await act(async () => {
      usePartEditorStore.setState({ bodies: makeBodyWithVertices() })
    })

    // autoZoomToFitNow succeeded: camera zoom changed from its initial value.
    expect(testCamera.zoom).not.toBe(zoomBefore)
  })

  it('does not zoom when bodies arrive while a sketch is being edited', async () => {
    const ref = createRef<ViewportHandle>()
    render(<Viewport ref={ref} />)

    // Simulate entering sketch edit: trigger an initial zoom first with no active feature,
    // then reset camera and enter edit mode.
    ref.current?.autoZoomToFit()
    await act(async () => {
      usePartEditorStore.setState({ bodies: makeBodyWithVertices() })
    })
    // Reset camera zoom to a sentinel value to detect any further zoom.
    testCamera.zoom = 999
    testCamera.updateProjectionMatrix()

    await act(async () => {
      // Enter sketch edit mode.
      usePartEditorStore.setState({ activeSketchFeatureId: 'sk1' })
      // Bodies change as rollback takes effect (e.g. extrude disappears).
      usePartEditorStore.setState({ bodies: {} })
      // Bodies come back for the sketch solve.
      usePartEditorStore.setState({ bodies: makeBodyWithVertices() })
    })

    // Camera zoom must not have been changed: auto-zoom is suppressed during sketch edit.
    expect(testCamera.zoom).toBe(999)
  })

  it('does not zoom when bodies arrive before activeSketchFeatureId is synced (race condition)', async () => {
    const ref = createRef<ViewportHandle>()
    render(<Viewport ref={ref} />)

    await act(async () => {
      usePartEditorStore.setState({ bodies: makeBodyWithVertices() })
    })
    testCamera.zoom = 999
    testCamera.updateProjectionMatrix()

    // Simulate the race: bodies update arrives in a separate act before activeSketchFeatureId is set.
    await act(async () => {
      usePartEditorStore.setState({ bodies: {} })
      usePartEditorStore.setState({ bodies: makeBodyWithVertices() })
    })
    await act(async () => {
      usePartEditorStore.setState({ activeSketchFeatureId: 'sk1' })
    })

    expect(testCamera.zoom).toBe(999)
  })

  it('re-fits when autoZoomToFit is called again (second document loaded, not a one-time latch)', async () => {
    const ref = createRef<ViewportHandle>()
    render(<Viewport ref={ref} />)

    // First document: geometry arrives and the camera fits.
    ref.current?.autoZoomToFit()
    await act(async () => {
      usePartEditorStore.setState({ bodies: makeBodyWithVertices() })
    })
    expect(testCamera.zoom).not.toBe(200)

    // User moves the camera; sentinel to detect a re-fit.
    testCamera.zoom = 999
    testCamera.updateProjectionMatrix()

    // Second document's first solve re-arms auto-fit via the imperative handle
    // (what Part.handleFirstSolve does). The old zoomDoneRef latch made this a
    // no-op; it must now re-fit the (already present) geometry.
    act(() => {
      ref.current?.autoZoomToFit()
    })

    expect(testCamera.zoom).not.toBe(999)
  })

  it('does not zoom via imperative handle if activeSketchFeatureId is set (onFirstSolve race)', async () => {
    const ref = createRef<ViewportHandle>()
    render(<Viewport ref={ref} />)

    testCamera.zoom = 999
    testCamera.updateProjectionMatrix()

    // Set both activeFeatureId and bodies in one update, simulating user entering
    // sketch edit before onFirstSolve's setTimeout fires.
    await act(async () => {
      usePartEditorStore.setState({ activeSketchFeatureId: 'sk1', bodies: makeBodyWithVertices() })
    })

    // The deferred onFirstSolve fires directly: zoomDoneRef is still false because
    // the effect skipped its autoZoomToFit call (activeFeatureId guard).
    act(() => {
      ref.current?.autoZoomToFit()
    })

    // Camera must NOT have zoomed -- autoZoomToFit should check
    // activeSketchFeatureId internally.
    expect(testCamera.zoom).toBe(999)
  })

  it('forced fit (Reset Viewport button) reframes even while editing a sketch', async () => {
    const ref = createRef<ViewportHandle>()
    render(<Viewport ref={ref} />)

    // Enter sketch edit with geometry present. An unforced fit is suppressed here.
    await act(async () => {
      usePartEditorStore.setState({ activeSketchFeatureId: 'sk1', bodies: makeBodyWithVertices() })
    })
    testCamera.zoom = 999
    testCamera.updateProjectionMatrix()

    // The Reset Viewport button passes force=true: a deliberate user request
    // reframes regardless of the editing guard.
    act(() => {
      ref.current?.autoZoomToFit(true)
    })

    expect(testCamera.zoom).not.toBe(999)
  })
})
