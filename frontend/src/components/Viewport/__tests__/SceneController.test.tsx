import React, { createRef } from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import * as THREE from 'three'
import SceneController from '@/components/Viewport/SceneController'
import { deriveOrbitEnabled } from '@/components/Viewport/orbitEnabled'
import { anglesFromDirection, TurntableControls } from '@/components/Viewport/turntable'

import type { Pv, Hit } from '@/components/misc/CubeGizmo.utils'
import { useEditorState } from '@/hooks/useEditorState'

const h = vi.hoisted(() => ({
  frameCallbacks: [] as Array<() => void>,
  invalidate: vi.fn(),
}))

vi.mock('@react-three/fiber', () => ({
  useThree: vi.fn(),
  // Captured, not run: the frame callback is the cube's paint path, and only
  // the tests that ask for it call it.
  useFrame: (cb: () => void) => { h.frameCallbacks.push(cb) },
}))

// Passthrough spy on the paint call: the demand-mode contract (the Canvas's
// invalidate reaches the cube's font-ready hook) is asserted at the call site.
vi.mock('@/components/misc/CubeGizmo.utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/misc/CubeGizmo.utils')>()
  return { ...actual, drawCubeGizmo: vi.fn(actual.drawCubeGizmo) }
})

function makeRef<T>(initial: T): React.MutableRefObject<T> {
  const ref = createRef() as React.MutableRefObject<T>
  ;(ref as unknown as Record<string, unknown>).current = initial
  return ref
}

// A stand-in WebGLRenderer: domElement is the surface the controls bind to.
// jsdom has no layout, so the viewport size is stated; otherwise every drag
// would be measured against the 1px fallback.
function makeGl() {
  const domElement = document.createElement('canvas')
  Object.defineProperty(domElement, 'clientWidth', { value: 800 })
  Object.defineProperty(domElement, 'clientHeight', { value: 600 })
  return { domElement }
}

function makeCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  cam.position.set(20, 20, 100)
  cam.zoom = 80
  cam.updateProjectionMatrix()
  return cam
}

function useThreeState(camera: THREE.Camera, gl = makeGl()) {
  return { camera, gl, scene: new THREE.Scene(), invalidate: h.invalidate, size: { width: 800, height: 600 } }
}

// jsdom has no PointerEvent constructor; a MouseEvent with the same type is
// indistinguishable to an addEventListener('pointerdown') handler and still
// carries button/modifiers/coords.
function press(el: Element | Document, type: string, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

function wheel(el: Element, deltaY: number): void {
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }))
}

function propsFor() {
  return {
    gizmoCanvasRef: makeRef<HTMLCanvasElement | null>(null),
    pvRef: makeRef<Pv[]>([]),
    hoverRef: makeRef<Hit | null>(null),
    snapRef: makeRef<THREE.Vector3 | null>(null),
    cameraRef: makeRef<THREE.Camera | null>(null),
    controlsRef: makeRef<TurntableControls | null>(null),
  }
}

function drag(el: Element, props: { button: number; from: [number, number]; to: [number, number]; mods?: MouseEventInit }) {
  press(el, 'pointerdown', { button: props.button, clientX: props.from[0], clientY: props.from[1], ...props.mods })
  press(document, 'pointermove', { button: props.button, clientX: props.to[0], clientY: props.to[1], ...props.mods })
  press(document, 'pointerup', { button: props.button, clientX: props.to[0], clientY: props.to[1], ...props.mods })
}

beforeEach(() => {
  h.frameCallbacks.length = 0
  h.invalidate.mockClear()
  useEditorState.setState({
    setIsRotating: () => {},
    isPointerDown: false,
    drag: null,
    dragPending: null,
  })
})

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

    const props = propsFor()
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(cam))

    const { rerender } = render(<SceneController {...props} />)

    // SceneController does NOT initialize the camera (the Canvas does); the
    // user-set pose is read into angles and written back, so compare within
    // float noise only.
    const expectPosition = (expected: [number, number, number]) => {
      const actual = cam.position.toArray()
      expect(actual[0]).toBeCloseTo(expected[0], 9)
      expect(actual[1]).toBeCloseTo(expected[1], 9)
      expect(actual[2]).toBeCloseTo(expected[2], 9)
    }
    expectPosition([50, 60, 100])
    expect(cam.zoom).toBe(300)

    // A re-render (e.g. canvas resize on sketch edit entry) must not move it.
    rerender(<SceneController {...props} />)

    expectPosition([50, 60, 100])
    expect(cam.zoom).toBe(300)
  })
})

describe('SceneController saved-orbit-state instance scoping', () => {
  it("does not let an unrelated torn-down instance's saved pose clobber a live instance's restore", async () => {
    const { useThree } = await import('@react-three/fiber')

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
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(camB1))
    const { rerender: rerenderB } = render(<SceneController {...propsB} />)

    // Instance A: an unrelated viewport that mounts and tears down elsewhere.
    // Its unmount cleanup saves camA's pose for restoration. With a
    // module-level save slot that pose sits in the shared slot after A is
    // gone; scoping the save per instance (the camera's userData) must discard
    // it along with A, so it can never reach B.
    const camA = makeCam([11, 22, 33], 111)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(camA))
    const { unmount: unmountA } = render(<SceneController {...propsFor()} />)
    unmountA()

    // B's effect re-fires (its `camera` dependency changes, as it would if the
    // Canvas handed it a new camera instance) without B ever having unmounted
    // or saved anything of its own.
    const camB2 = makeCam([44, 55, 66], 222)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(camB2))
    rerenderB(<SceneController {...propsB} />)

    // Let the effect's deferred render settle.
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })

    // B must keep its own pose -- it must not be silently teleported to
    // instance A's saved camera position/zoom.
    const actual = camB2.position.toArray()
    expect(actual[0]).toBeCloseTo(44, 9)
    expect(actual[1]).toBeCloseTo(55, 9)
    expect(actual[2]).toBeCloseTo(66, 9)
    expect(camB2.zoom).toBe(222)
  })
})

describe('SceneController orbit pose across a Suspense reveal', () => {
  // Regression: the pose save lived in a passive-effect cleanup and read the
  // controls ref, but React detaches that ref in the commit phase first, so the
  // save never ran and the rebuilt controls came back at the default (0,0,0)
  // target. The pose now rides on the camera's userData and is written by the
  // controller's own layout-effect cleanup, which still runs in the commit.
  it('restores the saved orbit pose onto the controller born at the reveal', async () => {
    const { useThree } = await import('@react-three/fiber')
    const { useLayoutEffect, useState } = await import('react')

    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(cam))

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

    const props = propsFor()
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
    // The controller attaches in a layout effect during the commit.
    await waitFor(() => expect(props.controlsRef.current).toBeTruthy())

    // The user frames the scene: pivot off the origin, and an upright pose with
    // a known position, then an inverted one would also be carried.
    const posed = props.controlsRef.current!
    const target = new THREE.Vector3(5, 6, 7)
    const position = new THREE.Vector3(10, 20, 30)
    const angles = anglesFromDirection(position.clone().sub(target), 0)
    posed.target.copy(target)
    posed.distance = position.distanceTo(target)
    posed.azimuth = angles.azimuth
    posed.elevation = angles.elevation
    cam.zoom = 42
    posed.update()
    expect(cam.position.toArray()).toEqual([10, 20, 30])

    // Hide: the teardown cleanup saves the posed orbit state in the commit,
    // so poll the camera until the save lands instead of sleeping a fixed 30ms.
    let releaseGate: () => void = () => {}
    gate = new Promise<void>(resolve => { releaseGate = resolve })
    await act(async () => { rerender(tree(true)) })
    await waitFor(() => expect((cam.userData as { turntablePose?: unknown }).turntablePose).toBeDefined())

    // Reveal: effects re-run and a FRESH controller is born; the saved pose
    // must land on that fresh instance's target, position and zoom.
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

describe('SceneController camera gestures', () => {
  it('rotates on right drag, pans on middle drag, zooms on the wheel and ignores the left button', async () => {
    const { useThree } = await import('@react-three/fiber')
    const cam = makeCamera()
    const gl = makeGl()
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(cam, gl))

    const props = propsFor()
    render(<SceneController {...props} />)
    const controls = props.controlsRef.current!
    expect(controls).toBeInstanceOf(TurntableControls)

    // Left drag is selection's: it must not touch the camera at all.
    const poseBefore = {
      position: cam.position.toArray(),
      azimuth: controls.azimuth,
      target: controls.target.toArray(),
      zoom: cam.zoom,
    }
    drag(gl.domElement, { button: 0, from: [100, 100], to: [180, 160] })
    expect(cam.position.toArray()).toEqual(poseBefore.position)
    expect(controls.azimuth).toBe(poseBefore.azimuth)
    expect(controls.target.toArray()).toEqual(poseBefore.target)
    expect(cam.zoom).toBe(poseBefore.zoom)

    // Right drag rotates: both angles move, the target stays put.
    const azimuthBefore = controls.azimuth
    const elevationBefore = controls.elevation
    drag(gl.domElement, { button: 2, from: [100, 100], to: [180, 160] })
    expect(controls.azimuth).not.toBe(azimuthBefore)
    expect(controls.elevation).not.toBe(elevationBefore)
    expect(controls.target.toArray()).toEqual([0, 0, 0])

    // Middle drag pans the target instead of rotating.
    const azimuthAfterRotate = controls.azimuth
    const targetBefore = controls.target.clone()
    drag(gl.domElement, { button: 1, from: [100, 100], to: [140, 130] })
    expect(controls.target.distanceTo(targetBefore)).toBeGreaterThan(0)
    expect(controls.azimuth).toBeCloseTo(azimuthAfterRotate, 12)

    // Wheel zooms the ortho projection only.
    const zoomBefore = cam.zoom
    wheel(gl.domElement, -100)
    expect(cam.zoom).toBeGreaterThan(zoomBefore)
    wheel(gl.domElement, 100)
    expect(cam.zoom).toBeCloseTo(zoomBefore, 12)
  })

  it('keeps shift+right as dolly and ctrl+right as pan, per press', async () => {
    const { useThree } = await import('@react-three/fiber')
    const cam = makeCamera()
    const gl = makeGl()
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(cam, gl))
    const props = propsFor()
    render(<SceneController {...props} />)
    const controls = props.controlsRef.current!

    const targetBefore = controls.target.clone()
    const zoomBefore = cam.zoom
    const elevationBefore = controls.elevation
    drag(gl.domElement, { button: 2, from: [100, 100], to: [100, 160], mods: { shiftKey: true } })
    expect(cam.zoom).not.toBe(zoomBefore)
    expect(controls.elevation).toBe(elevationBefore)
    expect(controls.target.toArray()).toEqual(targetBefore.toArray())

    drag(gl.domElement, { button: 2, from: [100, 100], to: [140, 120], mods: { ctrlKey: true } })
    expect(controls.target.distanceTo(targetBefore)).toBeGreaterThan(0)

    // The modifier mapping is re-evaluated on every press.
    const azimuthBefore = controls.azimuth
    drag(gl.domElement, { button: 2, from: [100, 100], to: [160, 100] })
    expect(controls.azimuth).not.toBe(azimuthBefore)
  })

  it('disables the controls during a sketch element drag', async () => {
    const { useThree } = await import('@react-three/fiber')
    const cam = makeCamera()
    const gl = makeGl()
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(cam, gl))
    const props = propsFor()
    const { rerender } = render(<SceneController {...props} />)

    act(() => {
      useEditorState.setState({ isPointerDown: true, drag: { featureId: 'S1' } as never })
    })
    rerender(<SceneController {...props} />)
    expect(props.controlsRef.current!.enabled).toBe(false)

    const azimuthBefore = props.controlsRef.current!.azimuth
    drag(gl.domElement, { button: 2, from: [100, 100], to: [180, 160] })
    expect(props.controlsRef.current!.azimuth).toBe(azimuthBefore)

    act(() => {
      useEditorState.setState({ isPointerDown: false, drag: null })
    })
    rerender(<SceneController {...props} />)
    expect(props.controlsRef.current!.enabled).toBe(true)
  })

  it('requests a frame on every pose change (demand rendering)', async () => {
    const { useThree } = await import('@react-three/fiber')
    const cam = makeCamera()
    const gl = makeGl()
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(cam, gl))
    const props = propsFor()
    render(<SceneController {...props} />)
    h.invalidate.mockClear()

    drag(gl.domElement, { button: 2, from: [100, 100], to: [140, 130] })
    expect(h.invalidate).toHaveBeenCalled()

    h.invalidate.mockClear()
    drag(gl.domElement, { button: 1, from: [100, 100], to: [140, 130] })
    expect(h.invalidate).toHaveBeenCalled()

    h.invalidate.mockClear()
    wheel(gl.domElement, -100)
    expect(h.invalidate).toHaveBeenCalled()
  })
})

describe('SceneController gizmo paint', () => {
  it('hands the Canvas invalidate to the cube paint so a late label font repaints on demand', async () => {
    const { useThree } = await import('@react-three/fiber')
    const { drawCubeGizmo } = await import('@/components/misc/CubeGizmo.utils')

    const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
    ;(useThree as unknown as ReturnType<typeof vi.fn>).mockReturnValue(useThreeState(cam))

    const gizmoOverlay = document.createElement('canvas')
    render(
      <SceneController
        gizmoCanvasRef={makeRef<HTMLCanvasElement | null>(gizmoOverlay)}
        pvRef={makeRef<Pv[]>([])}
        hoverRef={makeRef<Hit | null>(null)}
        snapRef={makeRef<THREE.Vector3 | null>(null)}
        cameraRef={makeRef<THREE.Camera | null>(null)}
        controlsRef={makeRef<TurntableControls | null>(null)}
      />
    )

    // The frame callback stands in for a drawn frame; the paint must receive
    // the invalidate as its font-ready hook, or a Roboto face that loads after
    // the frame that requested it would never repaint the cube.
    const frame = h.frameCallbacks.at(-1)!
    frame()

    expect(drawCubeGizmo).toHaveBeenCalledWith(gizmoOverlay, cam, null, h.invalidate)
  })
})
