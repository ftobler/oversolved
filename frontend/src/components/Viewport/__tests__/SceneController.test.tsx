import React, { createRef } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
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

// A fuller OrbitControls mock than a bare `() => null`: it wires the ref up to
// a minimal fake controls object (target + update) so SceneController's
// save-on-teardown effect has a truthy ctrlRef.current and actually runs.
// Deliberately NOT forwardRef/useImperativeHandle: React auto-nulls those
// refs during unmount's commit phase, before the passive effect cleanup
// that reads ctrlRef.current ever runs, which would make the guard always
// false and the save path untestable. A plain component reading `ref` as an
// ordinary prop (React 19) has no such auto-managed lifecycle, matching what
// the save/restore logic here is actually written to assume.
vi.mock('@react-three/drei', () => ({
  OrbitControls: (props: { ref?: (v: unknown) => void }) => {
    if (props.ref)
      props.ref({
        target: new THREE.Vector3(),
        update: () => {},
      })
    return null
  },
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

describe('SceneController saved-orbit-state instance scoping', () => {
  it("does not let an unrelated torn-down instance's saved pose clobber a live instance's restore", async () => {
    const { useThree } = await import('@react-three/fiber')

    const propsFor = () => ({
      canvasRef: makeRef<HTMLCanvasElement | null>(null),
      pvRef: makeRef<Pv[]>([]),
      hoverRef: makeRef<Hit | null>(null),
      snapRef: makeRef<THREE.Vector3 | null>(null),
      cameraRef: makeRef<THREE.Camera | null>(null),
      controlsRef: makeRef<OrbitControlsImpl | null>(null),
    })

    const makeCam = (pos: [number, number, number], zoom: number) => {
      const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
      cam.position.set(...pos)
      cam.zoom = zoom
      cam.updateProjectionMatrix()
      return cam
    }

    // Instance B: a live viewport that stays mounted for the whole test.
    const propsB = propsFor()
    const camB1 = makeCam([44, 55, 66], 222)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: camB1 })
    const { rerender: rerenderB } = render(<SceneController {...propsB} />)

    // Instance A: an unrelated viewport that mounts and tears down elsewhere.
    // Its unmount cleanup saves camA's pose for restoration. With a
    // module-level save slot that pose sits in the shared slot after A is
    // gone; scoping the save per instance (a ref) must discard it along
    // with A, so it can never reach B.
    const camA = makeCam([11, 22, 33], 111)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: camA })
    const { unmount: unmountA } = render(<SceneController {...propsFor()} />)
    unmountA()

    // B's restore effect re-fires (its `camera` dependency changes, as it
    // would if the Canvas handed it a new camera instance) without B ever
    // having unmounted or saved anything of its own.
    const camB2 = makeCam([44, 55, 66], 222)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: camB2 })
    rerenderB(<SceneController {...propsB} />)

    // Let the restore effect's deferred rAF run.
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })

    // B must keep its own pose -- it must not be silently teleported to
    // instance A's saved camera position/zoom.
    expect(camB2.position.toArray()).toEqual([44, 55, 66])
    expect(camB2.zoom).toBe(222)
  })
})
