import React, { createRef } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
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
// a minimal fake controls object (target + mouseButtons + update) so
// SceneController's pose save/restore has a truthy controls object to work
// with. It calls the ref in a layout effect (attach) and with null on unmount
// (detach). Layout timing is the point: React detaches a real callback ref in
// the commit phase, before any passive-effect cleanup, which is exactly why a
// save living in a passive cleanup always read a null controls. Using a
// passive effect here would hide that and let the buggy save appear to work.
// The fake is memoized per MOUNT, mirroring drei's own useMemo'd controls:
// re-renders keep the instance, only a key change produces a fresh one, so
// tests can tell "re-rendered" from "re-keyed" by instance identity.
vi.mock('@react-three/drei', async () => {
  const { useMemo, useLayoutEffect } = await import('react')
  const THREE = await import('three')
  return {
    OrbitControls: ({ ref }: { ref?: (v: unknown) => void }) => {
      const fake = useMemo(() => ({
        target: new THREE.Vector3(),
        update: () => {},
        // Mirrors three-stdlib's mutable action table, which is exactly what
        // the pointerdown remap writes into.
        mouseButtons: { RIGHT: THREE.MOUSE.ROTATE },
      }), [])
      useLayoutEffect(() => {
        ref?.(fake)
        return () => ref?.(null)
      }, [ref, fake])
      return null
    },
  }
})

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

// A stand-in WebGLRenderer: only domElement matters here, it is the element
// the right-button remap must bind to.
function makeGl() {
  return { domElement: document.createElement('canvas') }
}

// jsdom has no PointerEvent constructor; a MouseEvent with the same type is
// indistinguishable to an addEventListener('pointerdown') handler and still
// carries button/modifiers.
function pressRightButton(el: Element, mods: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('pointerdown', {
    button: 2, bubbles: true, cancelable: true, ...mods,
  }))
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

    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: cam, gl: makeGl() })

    const { rerender } = render(
      <SceneController
        gizmoCanvasRef={canvasRef}
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
        gizmoCanvasRef={canvasRef}
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
      gizmoCanvasRef: makeRef<HTMLCanvasElement | null>(null),
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
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: camB1, gl: makeGl() })
    const { rerender: rerenderB } = render(<SceneController {...propsB} />)

    // Instance A: an unrelated viewport that mounts and tears down elsewhere.
    // Its unmount cleanup saves camA's pose for restoration. With a
    // module-level save slot that pose sits in the shared slot after A is
    // gone; scoping the save per instance (a ref) must discard it along
    // with A, so it can never reach B.
    const camA = makeCam([11, 22, 33], 111)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: camA, gl: makeGl() })
    const { unmount: unmountA } = render(<SceneController {...propsFor()} />)
    unmountA()

    // B's restore effect re-fires (its `camera` dependency changes, as it
    // would if the Canvas handed it a new camera instance) without B ever
    // having unmounted or saved anything of its own.
    const camB2 = makeCam([44, 55, 66], 222)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: camB2, gl: makeGl() })
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

describe('SceneController orbit pose across a Suspense reveal', () => {
  // Regression: the pose save lived in a passive-effect cleanup and read the
  // controls ref, but React detaches that ref in the commit phase first, so the
  // save never ran and the rebuilt controls came back at the default (0,0,0)
  // target. The mock detaches its ref in a layout effect to preserve that
  // ordering, and the pose now rides on the camera's userData.
  it('restores the saved orbit target onto the controls instance born at the reveal', async () => {
    const { useThree } = await import('@react-three/fiber')
    const { useLayoutEffect, useState } = await import('react')

    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ camera: cam, gl: makeGl() })

    // R3F's actual suspension shape, which a plain sibling boundary does not
    // reproduce: the Canvas-wide Suspense's fallback (Block) flips the outer
    // Canvas component to a thrown never-resolving promise, so the whole
    // canvas subtree hides under the app boundary and every effect below is
    // torn down and re-runs on reveal. That teardown/re-run while the component
    // instance (and its refs) survives is exactly the cycle the save/showSeq
    // machinery exists for; production also runs under StrictMode, which
    // shapes those effect cycles, so both are reproduced here.
    function Block({ set }: { set: (v: boolean | Promise<null>) => void }): null {
      useLayoutEffect(() => {
        set(new Promise(() => null))
        return () => set(false)
      }, [set])
      return null
    }

    let gate: Promise<void> | null = null
    function Gate(): null {
      if (gate) throw gate
      return null
    }

    function R3fShapedCanvas({ children }: { children: React.ReactNode }) {
      const [block, setBlock] = useState<boolean | Promise<null>>(false)
      if (block) throw block
      return <React.Suspense fallback={<Block set={setBlock} />}>{children}</React.Suspense>
    }

    const props = {
      gizmoCanvasRef: makeRef<HTMLCanvasElement | null>(null),
      pvRef: makeRef<Pv[]>([]),
      hoverRef: makeRef<Hit | null>(null),
      snapRef: makeRef<THREE.Vector3 | null>(null),
      cameraRef: makeRef<THREE.Camera | null>(null),
      controlsRef: makeRef<OrbitControlsImpl | null>(null),
    }
    // No boundary above R3fShapedCanvas: like the real Canvas component, it
    // sits at the top of what this test renders, so its own thrown promise
    // parks the update instead of unmount/remount ping-pong through an
    // enclosing fallback.
    const tree = (suspended: boolean) => (
      <React.StrictMode>
        <R3fShapedCanvas>
          <SceneController {...props} />
          {suspended && <Gate />}
        </R3fShapedCanvas>
      </React.StrictMode>
    )

    const { rerender } = render(tree(false))
    // The controls attach in a layout effect during the commit.
    await waitFor(() => expect(props.controlsRef.current).toBeTruthy())

    // The user frames the scene: pivot off the origin.
    const posed = props.controlsRef.current!
    cam.position.set(10, 20, 30)
    cam.zoom = 42
    posed.target.set(5, 6, 7)

    // Hide: the teardown cleanup saves the posed orbit state in the commit,
    // so poll the camera until the save lands instead of sleeping a fixed 30ms.
    let releaseGate: () => void = () => {}
    gate = new Promise<void>(resolve => { releaseGate = resolve })
    await act(async () => { rerender(tree(true)) })
    await waitFor(() => expect((cam.userData as { orbitPose?: unknown }).orbitPose).toBeDefined())

    // Reveal: effects re-run and the key bump mounts a FRESH OrbitControls;
    // the saved pose must land on that fresh instance's target.
    gate = null
    await act(async () => { rerender(tree(false)); releaseGate() })

    await waitFor(() => {
      const restored = props.controlsRef.current!
      expect(restored).not.toBe(posed)
      expect(restored.target.toArray()).toEqual([5, 6, 7])
    })
    expect(cam.position.toArray()).toEqual([10, 20, 30])
    expect(cam.zoom).toBe(42)
  })
})

describe('SceneController right-button remap binding', () => {
  it('listens on the renderer canvas so the modifier remap works outside the gizmo corner', async () => {
    const { useThree } = await import('@react-three/fiber')

    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
    // Two distinct elements: what R3F renders into (where OrbitControls
    // listens) and the gizmo overlay CubeGizmoCanvas owns. The regression
    // this pins had them conflated: one shared ref put the listener on the
    // overlay, so shift/ctrl+right-drag was dead everywhere else.
    const rendererCanvas = document.createElement('canvas')
    const gizmoOverlay = document.createElement('canvas')
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      camera: cam,
      gl: { domElement: rendererCanvas },
    })

    const props = {
      gizmoCanvasRef: makeRef<HTMLCanvasElement | null>(gizmoOverlay),
      pvRef: makeRef<Pv[]>([]),
      hoverRef: makeRef<Hit | null>(null),
      snapRef: makeRef<THREE.Vector3 | null>(null),
      cameraRef: makeRef<THREE.Camera | null>(null),
      controlsRef: makeRef<OrbitControlsImpl | null>(null),
    }
    const { unmount } = render(<SceneController {...props} />)

    const mapping = () => props.controlsRef.current!.mouseButtons.RIGHT

    expect(mapping()).toBe(THREE.MOUSE.ROTATE)

    // Shift+right-drag dolly...
    pressRightButton(rendererCanvas, { shiftKey: true })
    expect(mapping()).toBe(THREE.MOUSE.DOLLY)
    // ...and the mutation must not stick: a plain press re-arms rotate,
    // because the mapping is re-evaluated on every pointerdown.
    pressRightButton(rendererCanvas)
    expect(mapping()).toBe(THREE.MOUSE.ROTATE)

    // Ctrl and meta pan.
    pressRightButton(rendererCanvas, { ctrlKey: true })
    expect(mapping()).toBe(THREE.MOUSE.PAN)
    pressRightButton(rendererCanvas, { metaKey: true })
    expect(mapping()).toBe(THREE.MOUSE.PAN)

    // A press on the gizmo overlay itself never touches the mapping: that
    // element only hosts hit-testing for the navigation cube.
    pressRightButton(rendererCanvas)
    pressRightButton(gizmoOverlay, { shiftKey: true })
    expect(mapping()).toBe(THREE.MOUSE.ROTATE)

    // Cleanup on unmount: the controls ref detaches and no further presses
    // reach the mapping.
    const controlsAtUnmount = props.controlsRef.current!
    unmount()
    expect(props.controlsRef.current).toBeNull()
    pressRightButton(rendererCanvas, { ctrlKey: true })
    expect(controlsAtUnmount.mouseButtons.RIGHT).toBe(THREE.MOUSE.ROTATE)
  })
})
