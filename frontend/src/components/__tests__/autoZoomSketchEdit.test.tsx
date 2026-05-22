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
  useThree: () => ({ camera: testCamera, gl: {}, scene: new THREE.Scene() }),
}))

vi.mock('@react-three/drei', () => ({
  OrthographicCamera: () => null,
  OrbitControls: () => null,
  Line: () => null,
  Text: () => null,
  Environment: () => null,
}))

vi.mock('../Geometry3D', () => ({ default: () => null, __esModule: true }))
vi.mock('../Geometry3D/Body3D', () => ({ default: () => null, __esModule: true }))
vi.mock('../Geometry3D/PreviewEdgeOverlay', () => ({ default: () => null, __esModule: true }))
vi.mock('../CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('../ContextMenuDialog', () => ({ default: () => null, __esModule: true }))
vi.mock('../Viewport/OriginMarker', () => ({ default: () => null, __esModule: true }))
vi.mock('../Viewport/ReferencePlane', () => ({ default: () => null, __esModule: true }))
// SceneController is NOT mocked so it runs and sets cameraRef.current = testCamera.
vi.mock('../Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1.0, ENV_MAP_INTENSITY: 1.0, __esModule: true }))
vi.mock('../Viewport/UserDefinedPlane', () => ({ default: () => null, __esModule: true }))
vi.mock('../Viewport/PlaneVisual', () => ({ PlaneSurface: () => null, PlaneLabel: () => null }))
vi.mock('../Viewport/idDispatch/useIdBufferPointerDispatch', () => ({ useIdBufferPointerDispatch: () => {} }))
vi.mock('../../picking/IdPickingDriver', () => ({ default: () => null, __esModule: true }))
vi.mock('../Viewport/IdDebugOverlay', () => ({ default: () => null, __esModule: true }))
vi.mock('../../picking/wasLastClickConsumedByIdDispatch', () => ({
  wasLastClickConsumedByIdDispatch: () => false,
  wasLastClickStaleResolve: () => false,
}))

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
    setHoveredBodyId: () => {},
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

    // Camera zoom must not have been changed — auto-zoom is suppressed during sketch edit.
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
})
