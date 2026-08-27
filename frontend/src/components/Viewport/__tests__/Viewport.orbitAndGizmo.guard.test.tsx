import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import * as THREE from 'three'
import { createRef } from 'react'
import { CubeGizmoCanvas } from '@/components/misc/CubeGizmo'
import { computeGizmoHit, GIZMO_SIZE } from '@/components/misc/CubeGizmo.utils'
import { deriveOrbitEnabled } from '@/components/Viewport/orbitEnabled'
import { runPointerUpCleanup } from '@/components/interaction/useSelectionPointerUpCleanup'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Pv, Hit } from '@/components/misc/CubeGizmo.utils'

// ─── Part-editor navigation cube: clicking a face snaps the camera ───
// Regression guard for "gizmo click broken / viewport no longer turns". The
// CubeGizmoCanvas owns no camera math: a click hit-tests against the projected
// cube (pvRef, cameraRef) and stashes the snap direction on snapRef, which
// SceneController.useFrame later consumes. This pins that the click path sets a
// non-null snap matching the hit face, using the real component (no mock).

const identityCamera = () => {
  const cam = new THREE.Camera()
  cam.quaternion.identity()
  return cam
}

describe('CubeGizmo click sets the camera snap direction', () => {
  it('stashes a front-face snapDir on snapRef when the centre is clicked', () => {
    const canvasRef = createRef<HTMLCanvasElement>()
    const pvRef = { current: [{ sx: 1, sy: 1, z: 0 }] as Pv[] }  // non-empty passes the guard
    const hoverRef = { current: null as Hit | null }
    const snapRef = { current: null as THREE.Vector3 | null }
    const cameraRef = { current: identityCamera() as THREE.Camera }

    const { container } = render(
      <CubeGizmoCanvas
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
      />
    )

    // Assign the DOM canvas the component expects.
    canvasRef.current = container.querySelector('canvas') as HTMLCanvasElement

    // The cube front face sits dead-centre for the identity camera.
    const C = GIZMO_SIZE / 2
    fireEvent.click(canvasRef.current, { clientX: C, clientY: C })

    expect(snapRef.current).not.toBeNull()
    expect(snapRef.current!.x).toBeCloseTo(0)
    expect(snapRef.current!.y).toBeCloseTo(0)
    expect(snapRef.current!.z).toBeCloseTo(1)

    // And the same coordinate really is a face hit via the shared hit-test.
    const hit = computeGizmoHit(C, C, pvRef.current, cameraRef.current)
    expect(hit).not.toBeNull()
    expect(hit!.type).toBe('face')
  })

  it('does NOT set a snap when the click lands off the cube', () => {
    const canvasRef = createRef<HTMLCanvasElement>()
    const pvRef = { current: [{ sx: 1, sy: 1, z: 0 }] as Pv[] }
    const hoverRef = { current: null as Hit | null }
    const snapRef = { current: null as THREE.Vector3 | null }
    const cameraRef = { current: identityCamera() as THREE.Camera }

    const { container } = render(
      <CubeGizmoCanvas
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
      />
    )
    canvasRef.current = container.querySelector('canvas') as HTMLCanvasElement

    fireEvent.click(canvasRef.current, { clientX: 2, clientY: 2 })
    expect(snapRef.current).toBeNull()
  })
})

// ─── SceneController consumes the snap every frame ───
// The click only writes snapRef; the camera actually turns when
// SceneController.useFrame reads snapRef and calls snapToDirection, then clears
// it. Guards the consumption half of the gizmo flow (the prior subagent found
// the assembly viewport correct; this pins the part-editor half).

const frameCb = vi.hoisted(() => ({ current: null as (() => void) | null }))

vi.mock('@react-three/fiber', () => ({
  useThree: vi.fn(() => ({ camera: new THREE.Camera(), gl: { domElement: document.createElement('canvas') } })),
  useFrame: (cb: () => void) => { frameCb.current = cb },
}))

vi.mock('@react-three/drei', () => ({
  OrbitControls: (props: { ref?: (v: unknown) => void }) => {
    const fake = { target: new THREE.Vector3(), update: () => {}, mouseButtons: { RIGHT: THREE.MOUSE.ROTATE } }
    if (props.ref) props.ref(fake)
    return null
  },
}))

describe('SceneController consumes the gizmo snap each frame', () => {
  it('snaps the camera and nulls snapRef when a gizmo snap is pending', async () => {
    const cameraController = await import('@/components/Viewport/cameraController')
    const snapToDir = vi.spyOn(cameraController, 'snapToDirection')

    const { useThree } = await import('@react-three/fiber')
    const cam = new THREE.Camera()
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: cam, gl: { domElement: document.createElement('canvas') } })

    const SceneController = (await import('@/components/Viewport/SceneController')).default
    const snapRef = { current: new THREE.Vector3(0, 0, 1) }
    const props = {
      gizmoCanvasRef: { current: null as HTMLCanvasElement | null },
      pvRef: { current: [] as Pv[] },
      hoverRef: { current: null as Hit | null },
      snapRef,
      cameraRef: { current: null as THREE.Camera | null },
      controlsRef: { current: null as unknown as never },
    }

    render(<SceneController {...props} />)
    expect(frameCb.current).not.toBeNull()

    act(() => { frameCb.current!() })

    // The pending snap was consumed: the camera snap ran and the ref cleared.
    expect(snapToDir).toHaveBeenCalledTimes(1)
    expect(snapToDir.mock.calls[0][2]).toBeInstanceOf(THREE.Vector3)
    expect(snapRef.current).toBeNull()
  })
})

// ─── Orbit enabled at rest after a gesture ends ───
// The camera must not freeze. deriveOrbitEnabled returns true whenever the
// pointer is up; useSelectionPointerUpCleanup clears isPointerDown on
// pointerup/cancel/lostcapture (and then the drag safety net clears any
// stranded drag/dragPending). This pins that a simulated pointerdown+pointerup
// leaves orbit free even if drag state was left stuck.

describe('Orbit is enabled at rest after a pointer gesture ends', () => {
  beforeEach(() => {
    vi.useRealTimers()
    useSketchEditorStore.setState({
      isPointerDown: false,
      drag: null,
      dragPending: null,
      setDrag: () => {},
      setDragPending: () => {},
      setDragStartClient: () => {},
      setDragSnap: () => {},
      setIsPointerDown: (v: boolean) => useSketchEditorStore.setState({ isPointerDown: v }),
    })
  })

  it('clears isPointerDown on pointerup so orbit re-enables after a drag', () => {
    // Simulate a sketch drag that began and left drag state stuck.
    useSketchEditorStore.setState({ isPointerDown: true })
    useSketchEditorStore.setState({ drag: { featureId: 'S1' } as never, dragPending: { featureId: 'S1' } as never })

    // The Viewport mounts useSelectionPointerUpCleanup, which binds this to the
    // window pointerup/cancel/lostcapture events. Calling it directly mirrors
    // that release path.
    runPointerUpCleanup()

    expect(useSketchEditorStore.getState().isPointerDown).toBe(false)
    // With the pointer up, orbit is enabled even before the deferred safety net.
    expect(deriveOrbitEnabled(useSketchEditorStore.getState().isPointerDown, useSketchEditorStore.getState().drag, useSketchEditorStore.getState().dragPending)).toBe(true)
  })

  it('the drag safety net clears stranded drag state after the pointer is up', () => {
    vi.useFakeTimers()
    const setDrag = vi.fn()
    const setDragPending = vi.fn()
    const setDragStartClient = vi.fn()
    const setDragSnap = vi.fn()
    // A gesture was active (isPointerDown true) and left drag state stuck.
    useSketchEditorStore.setState({
      isPointerDown: true, drag: { featureId: 'S1' } as never, dragPending: { featureId: 'S1' } as never,
      setDrag, setDragPending, setDragStartClient, setDragSnap,
    })

    runPointerUpCleanup()
    // Synchronous clear happened for the isPointerDown gate; the drag net is
    // deferred so it cannot clobber a real drag commit.
    vi.runAllTimers()

    expect(setDrag).toHaveBeenCalledWith(null)
    expect(setDragPending).toHaveBeenCalledWith(null)
    expect(setDragStartClient).toHaveBeenCalledWith(null)
    expect(setDragSnap).toHaveBeenCalledWith(null)
    vi.useRealTimers()
  })
})
