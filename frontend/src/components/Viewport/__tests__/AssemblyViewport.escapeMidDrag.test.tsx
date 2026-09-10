// Bug: Escape mid-drag abandoned the store session but left the click tracker
// pressed, so the release that followed paired with the stale down and selected
// the face behind the ring. The gesture machine now owns the tracker, and its
// one cancel transition resets it, so the stray release is inert.
//
// The scene furniture is mocked away; what is under test is the wrapper's
// pointer wiring against the real gesture machine and store.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, fireEvent, act } from '@testing-library/react'
import { GIZMO_HANDLE_LAYER_NAME, FACE_LAYER_NAME } from '@/picking'

const { pipeline, fakeGl } = vi.hoisted(() => {
  const canvas = {
    width: 64,
    height: 64,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 64, bottom: 64, width: 64, height: 64, toJSON() { return {} } }),
  }
  return {
    pipeline: { resolveAllSync: vi.fn(() => [] as unknown[]) },
    fakeGl: { domElement: canvas },
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
// The probe stands in for the real SceneController: it exposes a camera through
// the same cameraRef contract, so rayFromEvent has something to unproject from.
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

// jsdom has no PointerEvent constructor, so fireEvent.pointer* would degrade to
// a plain Event and drop button/pointerId. Scoped to this file.
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

// The release handler probes capture support before releasing; jsdom has no
// active-pointer notion, so shadow it.
const htmlProto = HTMLElement.prototype as unknown as Record<string, (pointerId: number) => unknown>
htmlProto.setPointerCapture = () => {}
htmlProto.releasePointerCapture = () => {}
htmlProto.hasPointerCapture = () => false

// The capture resolves the ring before the session opens; every later resolve
// sees what the session left behind. Once the session is gone that is the face
// the ring was drawn over, which is exactly the pick the stray release hit.
let opened = false

function seedStore() {
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
    bodies: { 'p1:body_0': { id: 'p1:body_0', created_by: 'p1', modified_by: [], mesh: {} } } as never,
  })
  // `subject`, `entitySelection`, `manipulation` and `gizmoDrag` are store-owned:
  // setSnapshot deliberately preserves them, so the seed is written directly.
  useAssemblyStore.getState().selectPart('p1')
  useAssemblyStore.setState({ entitySelection: new Set(), manipulation: null, gizmoDrag: null })
}

beforeEach(() => {
  opened = false
  pipeline.resolveAllSync.mockReset()
  pipeline.resolveAllSync.mockImplementation(() => {
    if (!opened) {
      opened = true
      return [{ layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gizmo:rotate:z' }]
    }
    return useAssemblyStore.getState().manipulation !== null
      ? [{ layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gizmo:rotate:z' }]
      : [{ layer: FACE_LAYER_NAME, entityKey: 'p1:body_0:face:0' }]
  })
  seedStore()
  setAssemblyCallbacks({
    mutateDoc: (_label, fn) => fn(useAssemblyStore.getState().doc!),
    mutateDocSession: (_label, fn) => fn(useAssemblyStore.getState().doc!),
    requestSolve: vi.fn(),
  })
})

describe('AssemblyViewport Escape mid-drag', () => {
  it('Escape then release selects nothing', () => {
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(useAssemblyStore.getState().manipulation).toBeNull()

    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })

    expect(useAssemblyStore.getState().entitySelection.size).toBe(0)
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })

  // Control: the same down/up on a ring with no Escape ends the gesture on the
  // handle, so it still selects nothing. This pins that the fix above did not
  // merely disable selection globally.
  it('a ring click with no Escape also selects nothing', () => {
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })

    expect(useAssemblyStore.getState().entitySelection.size).toBe(0)
  })
})
