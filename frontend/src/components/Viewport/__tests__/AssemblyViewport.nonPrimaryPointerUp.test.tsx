// Bug: handlePointerUp committed the session before it checked the releasing
// button, so a right-button release during a left drag wrote the doc and asked
// for a re-solve while the left button was still held. The gesture machine
// records the opening button and only an owned release ends the session, so a
// foreign release is inert and the drag survives it.
//
// The scene furniture is mocked away; what is under test is the wrapper's
// pointer wiring against the real gesture machine and store.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, fireEvent, act } from '@testing-library/react'
import { GIZMO_HANDLE_LAYER_NAME } from '@/picking'

const { pipeline, fakeGl, host } = vi.hoisted(() => {
  const canvas = {
    width: 64,
    height: 64,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 64, bottom: 64, width: 64, height: 64, toJSON() { return {} } }),
  }
  return {
    pipeline: { resolveAllSync: vi.fn(() => [] as unknown[]) },
    fakeGl: { domElement: canvas },
    host: { doc: null as unknown, mutateDoc: vi.fn(), requestSolve: vi.fn() },
  }
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: unknown; onCreated?: (s: unknown) => void }) => {
    useEffect(() => { onCreated?.({ gl: fakeGl, scene: { traverse: () => {} } }) }, [onCreated])
    return children as React.ReactNode
  },
}))
vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({
  default: function IdPickingDriverStub({ onReady }: { onReady?: (p: unknown) => void }) {
    useEffect(() => { onReady?.(pipeline) }, [onReady])
    return null
  },
}))
vi.mock('@/components/Viewport/SceneController', async () => {
  const THREE = await import('three')
  return {
    default: function SceneControllerProbe({ cameraRef }: { cameraRef: { current: unknown } }) {
      useEffect(() => {
        const cam = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
        cam.position.set(0, 0, 100)
        cam.lookAt(0, 0, 0)
        cam.updateMatrixWorld(true)
        cam.updateProjectionMatrix()
        cameraRef.current = cam
      }, [cameraRef])
      return null
    },
  }
})
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
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

if (typeof window.PointerEvent !== 'function') {
  window.PointerEvent = class PointerEventStub extends MouseEvent {
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      Object.defineProperty(this, 'isPrimary', { value: init.isPrimary ?? false, enumerable: true })
      Object.defineProperty(this, 'pointerId', { value: init.pointerId ?? 0, enumerable: true })
      Object.defineProperty(this, 'pointerType', { value: init.pointerType ?? 'mouse', enumerable: true })
    }
  } as unknown as typeof PointerEvent
}

const htmlProto = HTMLElement.prototype as unknown as Record<string, (pointerId: number) => unknown>
htmlProto.setPointerCapture = () => {}
htmlProto.releasePointerCapture = () => {}
htmlProto.hasPointerCapture = () => false

function seedDoc() {
  return {
    kind: 'assembly' as const,
    features: [{
      id: 'f0',
      kind: 'part_instance' as const,
      instance: { handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } },
    }],
  }
}

beforeEach(() => {
  const doc = seedDoc()
  host.doc = doc
  host.mutateDoc.mockReset()
  host.mutateDoc.mockImplementation((_label: string, fn: (d: unknown) => unknown) => { host.doc = fn(host.doc) })
  host.requestSolve.mockReset()

  pipeline.resolveAllSync.mockReset()
  pipeline.resolveAllSync.mockImplementation(() => [{ layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gizmo:translate:x' }])

  useAssemblyStore.getState().setSnapshot({
    ...DEFAULT_ASSEMBLY_EDITOR_DATA,
    doc,
    instances: [{ handle: 'p1', doc_id: 'doc-p1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } }],
    transforms: { p1: { ...IDENTITY_TRANSFORM } },
    bodies: { 'p1:body_0': { id: 'p1:body_0', created_by: 'p1', modified_by: [], mesh: {} } } as never,
  })
  useAssemblyStore.getState().selectPart('p1')
  useAssemblyStore.setState({ entitySelection: new Set(), manipulation: null, gizmoDrag: null })

  setAssemblyCallbacks({
    mutateDoc: host.mutateDoc,
    mutateDocSession: host.mutateDoc,
    requestSolve: host.requestSolve,
  })
})

describe('AssemblyViewport non-primary pointer-up', () => {
  it('a right-button release does not commit the live left drag', () => {
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()

    act(() => { fireEvent.pointerMove(el, { clientX: 60, clientY: 32, buttons: 1, pointerId: 1 }) })
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()

    // The foreign release must not end the gesture or touch the doc.
    act(() => { fireEvent.pointerUp(el, { button: 2, isPrimary: true, pointerId: 1, clientX: 60, clientY: 32 }) })
    expect(host.mutateDoc).not.toHaveBeenCalled()
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()

    // The opening button still commits the same drag exactly once.
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 60, clientY: 32 }) })
    expect(host.mutateDoc).toHaveBeenCalledTimes(1)
    expect(host.mutateDoc.mock.calls[0][0]).toBe('Move part')
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })

  it('a second touch while active leaves the first session live', () => {
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })
    const first = useAssemblyStore.getState().manipulation
    expect(first).not.toBeNull()
    expect(useAssemblyStore.getState().gizmoDrag).toEqual({ kind: 'axis', axis: 'x' })

    // A second finger lands on the gizmo. It must neither open over the live
    // session nor fall through the store write the machine would then refuse.
    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: false, pointerId: 2, clientX: 40, clientY: 32 }) })
    expect(useAssemblyStore.getState().manipulation).toBe(first)
    expect(useAssemblyStore.getState().gizmoDrag).toEqual({ kind: 'axis', axis: 'x' })

    // The second pointer's release is inert; the first still owns the drag.
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: false, pointerId: 2, clientX: 40, clientY: 32 }) })
    expect(useAssemblyStore.getState().manipulation).toBe(first)

    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })
})
