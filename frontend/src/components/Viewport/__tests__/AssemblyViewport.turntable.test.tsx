// Test 12 of the turntable feature: the assembly viewport shares the part
// viewport's SceneController, so it must get the same turntable bindings. This
// mounts the real SceneController (not a probe) against a stand-in Canvas and
// drives the renderer canvas directly, proving right-drag rotates, middle-drag
// pans, the wheel zooms, and the left button stays free for selection.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'
import { GIZMO_HANDLE_LAYER_NAME } from '@/picking'

const h = vi.hoisted(() => {
  const domElement = document.createElement('canvas')
  Object.defineProperty(domElement, 'clientWidth', { value: 800 })
  Object.defineProperty(domElement, 'clientHeight', { value: 600 })
  Object.defineProperty(domElement, 'getBoundingClientRect', {
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {} } }),
  })
  return {
    camera: null as THREE.OrthographicCamera | null,
    gl: { domElement },
    scene: null as THREE.Scene | null,
    invalidate: vi.fn(),
    pipeline: { resolveAllSync: vi.fn(() => [] as unknown[]) },
  }
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: unknown; onCreated?: (s: unknown) => void }) => {
    useEffect(() => {
      onCreated?.({ gl: h.gl, scene: h.scene, camera: h.camera })
    }, [onCreated])
    return children as React.ReactNode
  },
  useThree: () => ({
    camera: h.camera,
    gl: h.gl,
    scene: h.scene,
    invalidate: h.invalidate,
    size: { width: 800, height: 600 },
  }),
  useFrame: () => {},
}))
vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({
  default: function IdPickingDriverStub({ onReady }: { onReady?: (p: unknown) => void }) {
    useEffect(() => { onReady?.(h.pipeline) }, [onReady])
    return null
  },
}))
vi.mock('@/components/Viewport/EnvLight', () => ({ default: () => null, ENV_INTENSITY: 1 }))
vi.mock('@/components/Viewport/IdDebugOverlay', () => ({ default: () => null }))
vi.mock('@/components/misc/CubeGizmo', () => ({ CubeGizmoCanvas: () => null }))
vi.mock('@/components/Viewport/assembly/AnchorGizmos', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPartMesh', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyBuiltin', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblyPickLayers', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/AssemblySelectionHighlight', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/GizmoPickLayer', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/RollGuideGizmo', () => ({ default: () => null }))
vi.mock('@/components/Viewport/assembly/TriadGizmo', () => ({ default: () => null }))

import AssemblyViewport from '../AssemblyViewport'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { installPointerEventStub } from '@/testing/pointerEventStub'

installPointerEventStub('touch')

// jsdom has no PointerEvent constructor; a MouseEvent with the same type is
// indistinguishable to an addEventListener('pointerdown') handler and still
// carries button/modifiers/coords.
function press(el: Element | Document, type: string, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

// The release path probes capture support; jsdom has no active-pointer notion.
const htmlProto = HTMLElement.prototype as unknown as Record<string, (pointerId: number) => unknown>
htmlProto.setPointerCapture = () => {}
htmlProto.releasePointerCapture = () => {}
htmlProto.hasPointerCapture = () => false

function touch(el: Element | Document, type: string, pointerId: number, clientX: number, clientY: number): void {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true,
    pointerId, button: 0, clientX, clientY,
  }))
}

function seedAssembly(): void {
  const doc = {
    kind: 'assembly' as const,
    features: [{
      id: 'f0',
      kind: 'part_instance' as const,
      instance: { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } },
    }],
  }
  useAssemblyStore.getState().setSnapshot({
    ...DEFAULT_ASSEMBLY_EDITOR_DATA,
    doc,
    instances: [{ handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } }],
    transforms: { p1: { ...IDENTITY_TRANSFORM } },
    parts: { 'p1:body_0': { id: 'p1:body_0', created_by: 'p1', modified_by: [], mesh: {} } } as never,
  })
  useAssemblyStore.setState({ manipulation: null, gizmoDrag: null, subject: null })
  useAssemblyStore.getState().selectPart('p1')
}

function drag(button: number, from: [number, number], to: [number, number]): void {
  press(h.gl.domElement, 'pointerdown', { button, clientX: from[0], clientY: from[1] })
  press(document, 'pointermove', { button, clientX: to[0], clientY: to[1] })
  press(document, 'pointerup', { button, clientX: to[0], clientY: to[1] })
}

function resetCamera(): void {
  h.camera!.position.set(20, 20, 100)
  h.camera!.zoom = 80
  h.camera!.up.set(0, 1, 0)
  h.camera!.updateProjectionMatrix()
}

beforeEach(() => {
  h.camera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  h.scene = new THREE.Scene()
  resetCamera()
  h.invalidate.mockClear()
  h.pipeline.resolveAllSync.mockReset()
  h.pipeline.resolveAllSync.mockImplementation(() => [])
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({ pickGeometryPose: {}, entitySelection: new Set(), bodies: {} } as never)
  setAssemblyCallbacks({
    mutateDoc: (_label, fn) => fn(useAssemblyStore.getState().doc!),
    mutateDocSession: (_label, fn) => fn(useAssemblyStore.getState().doc!),
    requestSolve: vi.fn(),
  })
})

describe('AssemblyViewport turntable', () => {
  it('right-drag rotates the shared trackball orbit', () => {
    render(<AssemblyViewport />)
    const before = h.camera!.position.clone()

    act(() => drag(2, [100, 100], [160, 40]))

    expect(h.camera!.position.distanceTo(before)).toBeGreaterThan(1)
    // The assembly viewport gets the same screen-axis orbit: a rigid turn about
    // the target, so the eye keeps its distance (a diagonal drag may tilt the
    // horizon; that is the law, not a defect).
    expect(h.camera!.position.length()).toBeCloseTo(before.length(), 6)
    expect(h.invalidate).toHaveBeenCalled()
  })

  it('a touch triad drag moves the part and leaves the camera alone until release', () => {
    // The assembly gates the camera on `!manipulating`, a React commit. A touch
    // press is also a one-finger camera gesture, so the press must claim the
    // pointer synchronously or the first moves orbit.
    seedAssembly()
    h.pipeline.resolveAllSync.mockImplementation(() => ([
      { layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gizmo:translate:x' },
    ]))
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element
    const before = { position: h.camera!.position.toArray(), quaternion: h.camera!.quaternion.toArray() }

    act(() => {
      // The controller's canvas listener saw the press first, then the capture
      // phase opens the session and claims the same pointer.
      touch(h.gl.domElement, 'pointerdown', 5, 32, 32)
      touch(el, 'pointerdown', 5, 32, 32)
      // This move lands before the disabled gate commits: only the claim can
      // keep the camera still.
      touch(el, 'pointermove', 5, 52, 32)
    })

    const session = useAssemblyStore.getState().manipulation
    expect(session).not.toBeNull()
    expect(session!.current).not.toEqual(session!.seed)
    expect({ position: h.camera!.position.toArray(), quaternion: h.camera!.quaternion.toArray() }).toEqual(before)

    act(() => {
      touch(el, 'pointerup', 5, 52, 32)
    })
    expect(useAssemblyStore.getState().manipulation).toBeNull()

    // The claim went with the release: one finger on empty space orbits again.
    const posed = h.camera!.position.clone()
    act(() => {
      touch(h.gl.domElement, 'pointerdown', 6, 300, 300)
      touch(document, 'pointermove', 6, 360, 340)
      touch(document, 'pointerup', 6, 360, 340)
    })
    expect(h.camera!.position.distanceTo(posed)).toBeGreaterThan(0.1)
  })

  it('middle-drag pans and the wheel zooms, while the left button does nothing', () => {
    render(<AssemblyViewport />)
    const rotated = h.camera!.position.clone()
    const zoomBefore = h.camera!.zoom

    act(() => drag(1, [100, 100], [140, 130]))
    expect(h.camera!.position.distanceTo(rotated)).toBeGreaterThan(0.1)

    const panned = h.camera!.position.clone()
    act(() => drag(0, [100, 100], [180, 160]))
    expect(h.camera!.position.distanceTo(panned)).toBeLessThan(1e-9)

    act(() => {
      h.gl.domElement.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }))
    })
    expect(h.camera!.zoom).not.toBe(zoomBefore)
  })
})
