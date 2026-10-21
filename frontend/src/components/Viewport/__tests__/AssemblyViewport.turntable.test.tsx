// Test 12 of the turntable feature: the assembly viewport shares the part
// viewport's SceneController, so it must get the same turntable bindings. This
// mounts the real SceneController (not a probe) against a stand-in Canvas and
// drives the renderer canvas directly, proving right-drag rotates, middle-drag
// pans, the wheel zooms, and the left button stays free for selection.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'

const h = vi.hoisted(() => {
  const domElement = document.createElement('canvas')
  Object.defineProperty(domElement, 'clientWidth', { value: 800 })
  Object.defineProperty(domElement, 'clientHeight', { value: 600 })
  return {
    camera: null as THREE.OrthographicCamera | null,
    gl: { domElement },
    scene: null as THREE.Scene | null,
    invalidate: vi.fn(),
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
vi.mock('@/picking/IdPickingDriver', () => ({ default: () => null }))
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

// jsdom has no PointerEvent constructor; a MouseEvent with the same type is
// indistinguishable to an addEventListener('pointerdown') handler and still
// carries button/modifiers/coords.
function press(el: Element | Document, type: string, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
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
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.setState({ pickGeometryPose: {}, entitySelection: new Set(), bodies: {} } as never)
})

describe('AssemblyViewport turntable', () => {
  it('right-drag rotates the shared unclamped turntable', () => {
    render(<AssemblyViewport />)
    const before = h.camera!.position.clone()

    act(() => drag(2, [100, 100], [160, 40]))

    expect(h.camera!.position.distanceTo(before)).toBeGreaterThan(1)
    // The level-horizon invariant holds in the assembly viewport too: the
    // camera's local X (screen right) has no world-Y component.
    const right = new THREE.Vector3().setFromMatrixColumn(h.camera!.matrixWorld, 0)
    expect(Math.abs(right.y)).toBeLessThan(1e-9)
    expect(h.invalidate).toHaveBeenCalled()
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
