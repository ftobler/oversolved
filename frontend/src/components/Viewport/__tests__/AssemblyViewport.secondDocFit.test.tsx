// Second-document auto-fit in the assembly viewport: opening another assembly
// remounts the Canvas, whose scene tree (SceneController) renders on a later
// frame. The document's first geometry can land while the camera is still
// absent, so the bodies-driven fit effect fires as a no-op and never fires
// again -- the fit must be re-attempted when the camera becomes live.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'

// Mutable so the test controls when the scene camera "renders into" the
// viewport, mirroring the late R3F scene-tree reveal of a SPA remount.
const probe = vi.hoisted(() => ({
  camera: null as THREE.Camera | null,
  gen: 0,
}))

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: unknown; onCreated?: (s: unknown) => void }) => {
    useEffect(() => { onCreated?.({ gl: { domElement: document.createElement('canvas') }, scene: {} }) }, [onCreated])
    return children as React.ReactNode
  },
}))
vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({ default: () => null }))
// The probe stands in for the real SceneController: it exposes the camera
// through the same cameraRef contract, then fires onReady (the readiness
// signal under test) on every generation bump.
vi.mock('@/components/Viewport/SceneController', () => ({
  default: function SceneControllerProbe({ cameraRef, onReady }: { cameraRef: { current: THREE.Camera | null }; onReady?: () => void }) {
    useEffect(() => {
      if (probe.camera) cameraRef.current = probe.camera
      onReady?.()
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the generation is the test's re-render probe; bumping it is what re-fires the signal
    }, [probe.gen, cameraRef, onReady])
    return null
  },
}))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1 }))
vi.mock('@/components/Viewport/IdDebugOverlay', () => ({ default: () => null }))
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('@/components/Viewport/assembly/AnchorGizmos', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyBody', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyBuiltin', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPickLayers', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblySelectionHighlight', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/GizmoPickLayer', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/RollGuideGizmo', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/TriadGizmo', () => ({ default: () => null }))

import AssemblyViewport from '../AssemblyViewport'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

// Non-degenerate vertices so fitToContent has real bounds to frame.
function bodyWithVertices(): Record<string, unknown> {
  return {
    body1: {
      id: 'body1',
      mesh: {
        vertices: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
        faces: [],
        face_data: [],
        face_queries: [],
      },
    },
  }
}

function probeCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  cam.position.set(20, 20, 100)
  cam.updateProjectionMatrix()
  return cam
}

beforeEach(() => {
  probe.camera = null
  probe.gen = 0
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({ pickGeometryPose: {}, entitySelection: new Set() } as never)
})

describe('AssemblyViewport fit on a late scene camera', () => {
  it('fits when the camera arrives after the geometry did (second document in a SPA)', () => {
    const cam = probeCamera()
    // Geometry is already in the store: the bodies-driven fit effect ran at
    // mount as a no-op, because the scene tree has not rendered yet.
    useAssemblyStore.setState({ bodies: bodyWithVertices() } as never)

    const { rerender } = render(<AssemblyViewport />)

    // The scene tree then renders and exposes the camera; no bodies change
    // follows, so only the readiness-driven retry can land the fit.
    act(() => {
      probe.camera = cam
      probe.gen++
      rerender(<AssemblyViewport />)
    })

    expect(cam.zoom).not.toBe(1)
  })
})
