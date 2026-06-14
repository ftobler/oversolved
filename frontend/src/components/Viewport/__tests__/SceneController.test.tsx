import React, { createRef } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'
import SceneController from '@/components/Viewport/SceneController'
import { deriveOrbitEnabled } from '@/components/Viewport/orbitEnabled'
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
    setIsRotating: () => {},
  })
})

function makeRef<T>(initial: T): React.MutableRefObject<T> {
  const ref = createRef() as React.MutableRefObject<T>
  ;(ref as unknown as Record<string, unknown>).current = initial
  return ref
}

describe('deriveOrbitEnabled', () => {
  const drag = { featureId: 'S1' }
  const pending = { featureId: 'S1' }

  it('disables orbit only during an active pointer-down element drag', () => {
    expect(deriveOrbitEnabled(true, drag, null)).toBe(false)
    expect(deriveOrbitEnabled(true, null, pending)).toBe(false)
  })

  it('keeps orbit enabled while the pointer is up regardless of stale drag state', () => {
    // Load race: DragPlane unmounted mid-gesture left drag/dragPending stuck,
    // but the pointer is up so the camera must not freeze.
    expect(deriveOrbitEnabled(false, drag, null)).toBe(true)
    expect(deriveOrbitEnabled(false, null, pending)).toBe(true)
    expect(deriveOrbitEnabled(false, drag, pending)).toBe(true)
  })

  it('keeps orbit enabled when pressing on empty space (no element drag)', () => {
    // Camera rotate/pan does not set drag/dragPending; isPointerDown stays false.
    expect(deriveOrbitEnabled(false, null, null)).toBe(true)
    expect(deriveOrbitEnabled(true, null, null)).toBe(true)
  })
})

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
})
