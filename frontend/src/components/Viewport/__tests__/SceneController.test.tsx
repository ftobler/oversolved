import React, { createRef } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'
import SceneController from '@/components/Viewport/SceneController'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Pv, Hit } from '@/components/CubeGizmo.utils'

vi.mock('@react-three/fiber', () => ({
  useThree: vi.fn(),
  useFrame: () => {},
}))

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
}))

beforeEach(() => {
  useSketchEditorStore.setState({
    orbitEnabled: true,
    setIsRotating: () => {},
  })
})

function makeRef<T>(initial: T): React.MutableRefObject<T> {
  const ref = createRef() as React.MutableRefObject<T>
  ;(ref as unknown as Record<string, unknown>).current = initial
  return ref
}

describe('SceneController camera preservation', () => {
  it('initializes the first camera and preserves the user pose when R3F swaps the camera instance', async () => {
    const { useThree } = await import('@react-three/fiber')

    const cam1 = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)

    const cameraRef = makeRef<THREE.Camera | null>(null)
    const canvasRef = makeRef<HTMLCanvasElement | null>(null)
    const pvRef = makeRef<Pv[]>([])
    const hoverRef = makeRef<Hit | null>(null)
    const snapRef = makeRef<THREE.Vector3 | null>(null)
    const controlsRef = makeRef<OrbitControlsImpl | null>(null)

    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: cam1 })

    const { rerender } = render(
      <SceneController
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
        controlsRef={controlsRef}
      />
    )

    // The first camera instance is placed at the initial pose.
    expect(cam1.position.x).toBe(20)
    expect(cam1.zoom).toBe(200)

    // The user orbits/zooms.
    cam1.position.set(50, 60, 100)
    cam1.zoom = 300
    cam1.updateProjectionMatrix()

    // R3F swaps the camera instance on sketch edit entry. The new instance
    // (born at defaults) must inherit the user's current pose, NOT reset to
    // the initial view.
    const cam2 = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: cam2 })

    rerender(
      <SceneController
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
        controlsRef={controlsRef}
      />
    )

    expect(cameraRef.current).toBe(cam2)
    expect(cam2.position.x).toBe(50)
    expect(cam2.position.y).toBe(60)
    expect(cam2.position.z).toBe(100)
    expect(cam2.zoom).toBe(300)
  })

  it('resets camera when resetTrigger changes', async () => {
    const { useThree } = await import('@react-three/fiber')

    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)

    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: cam })

    const cameraRef = makeRef<THREE.Camera | null>(null)
    const canvasRef = makeRef<HTMLCanvasElement | null>(null)
    const pvRef = makeRef<Pv[]>([])
    const hoverRef = makeRef<Hit | null>(null)
    const snapRef = makeRef<THREE.Vector3 | null>(null)
    const controlsRef = makeRef<OrbitControlsImpl | null>(null)

    const { rerender } = render(
      <SceneController
        resetTrigger={0}
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
        controlsRef={controlsRef}
      />
    )

    // Simulate the user moving the camera away from the initial pose.
    cam.position.set(50, 60, 100)
    cam.zoom = 300
    cam.updateProjectionMatrix()
    expect(cam.zoom).toBe(300)

    // Trigger reset
    rerender(
      <SceneController
        resetTrigger={1}
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
        controlsRef={controlsRef}
      />
    )

    // Camera should be at initial position
    expect(cam.position.x).toBe(20)
    expect(cam.position.y).toBe(20)
    expect(cam.position.z).toBe(100)
    expect(cam.zoom).toBe(200)
  })
})
