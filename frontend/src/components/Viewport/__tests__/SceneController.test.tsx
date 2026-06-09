import React, { createRef } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'
import SceneController from '@/components/Viewport/SceneController'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Pv, Hit } from '@/components/misc/CubeGizmo.utils'

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
  it('never touches the camera on re-render (camera is owned by the Canvas, user controlled)', async () => {
    const { useThree } = await import('@react-three/fiber')

    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
    cam.position.set(50, 60, 100)
    cam.zoom = 300
    cam.updateProjectionMatrix()

    const cameraRef = makeRef<THREE.Camera | null>(null)
    const canvasRef = makeRef<HTMLCanvasElement | null>(null)
    const pvRef = makeRef<Pv[]>([])
    const hoverRef = makeRef<Hit | null>(null)
    const snapRef = makeRef<THREE.Vector3 | null>(null)
    const controlsRef = makeRef<OrbitControlsImpl | null>(null)

    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: cam })

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

    // SceneController does NOT initialize the camera (the Canvas does); the
    // user-set pose must be left exactly as-is.
    expect(cam.position.toArray()).toEqual([50, 60, 100])
    expect(cam.zoom).toBe(300)

    // A re-render (e.g. canvas resize on sketch edit entry) must not move it.
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

    expect(cam.position.toArray()).toEqual([50, 60, 100])
    expect(cam.zoom).toBe(300)
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
