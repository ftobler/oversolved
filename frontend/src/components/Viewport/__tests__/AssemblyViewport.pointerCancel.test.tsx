// L29 review-17 regression: pointercancel closed the drag session but left the
// click-gesture tracker open, so correctness rested on an up always following a
// down. When the browser tears a gesture away no up comes: the stale origin
// then pairs with the NEXT release, or feeds onPointerMissed a stationary-click
// verdict from a gesture that was cancelled -- wiping the selection over a
// touch that turned into a scroll. Mirrors the part editor's cancel handling.
//
// The later review added a second regression: pointercancel must clear the live
// store session and gizmoDrag too, or a browser-cancelled drag leaves the
// camera locked with no pointerup to release it.
//
// The scene furniture is mocked away; what is under test is the wrapper's
// pointer wiring against the real gesture machine and store.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, act, fireEvent } from '@testing-library/react'
import { FACE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME } from '@/picking'

const { pipeline, fakeGl, missedFn } = vi.hoisted(() => {
  const canvas = {
    width: 64,
    height: 64,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 64, bottom: 64, width: 64, height: 64, toJSON() { return {} } }),
  }
  return {
    pipeline: { resolveAllSync: vi.fn(() => [] as unknown[]) },
    fakeGl: { domElement: canvas },
    missedFn: { current: null as (() => void) | null },
  }
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated, onPointerMissed }: { children: unknown; onCreated?: (s: unknown) => void; onPointerMissed?: () => void }) => {
    missedFn.current = onPointerMissed ?? null
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

// jsdom has no PointerEvent constructor, so fireEvent.pointer* would degrade to
// a plain Event and drop pointerId. Scoped to this file only.
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
// active-pointer notion, so shadow it like Viewport.pointerLeave.test.tsx does.
const htmlProto = HTMLElement.prototype as unknown as Record<string, (pointerId: number) => unknown>
htmlProto.setPointerCapture = () => {}
htmlProto.releasePointerCapture = () => {}
htmlProto.hasPointerCapture = () => false

function seededSelection(): Set<string> {
  return new Set(['part-1|face|0'])
}

function seedAssembly() {
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
  useAssemblyStore.getState().selectPart('p1')
}

beforeEach(() => {
  const store = useAssemblyStore.getState()
  store.setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  store.clearHover()
  store.setHoveredEntity(null)
  useAssemblyStore.setState({ entitySelection: seededSelection(), subject: null, manipulation: null, gizmoDrag: null })
  missedFn.current = null
  pipeline.resolveAllSync.mockReset()
  pipeline.resolveAllSync.mockImplementation(() => [])
  setAssemblyCallbacks({
    mutateDoc: (_label, fn) => fn(useAssemblyStore.getState().doc!),
    mutateDocSession: (_label, fn) => fn(useAssemblyStore.getState().doc!),
    requestSolve: vi.fn(),
  })
})

describe('AssemblyViewport pointercancel closes the pending click gesture', () => {
  it('a cancelled gesture leaves nothing for its stray release to judge', () => {
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1 }) })
    act(() => { fireEvent.pointerCancel(el, { pointerId: 1 }) })
    // The torn-away gesture's late release must find no open gesture to close.
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerId: 1 }) })

    // R3F fires the miss for the click that followed the cancelled steal. With
    // the tracker still holding the cancelled gesture this read as a stationary
    // left click and wiped the selection.
    act(() => { missedFn.current?.() })
    expect([...useAssemblyStore.getState().entitySelection]).toEqual([...seededSelection()])
  })

  it('a completed stationary click on empty space still deselects (control)', () => {
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1 }) })
    act(() => { fireEvent.pointerUp(el, { button: 0, isPrimary: true, pointerId: 1 }) })
    act(() => { missedFn.current?.() })
    expect(useAssemblyStore.getState().entitySelection.size).toBe(0)
  })

  // The second regression: a live gizmo drag cancelled by the browser must take
  // the store session and gizmoDrag with it, or the camera stays locked with no
  // pointerup left to release it.
  it('a pointercancel mid-drag clears the live manipulation and gizmoDrag', () => {
    seedAssembly()
    pipeline.resolveAllSync.mockImplementation(() => ([
      { layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gizmo:translate:x' },
    ]))
    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()

    act(() => { fireEvent.pointerCancel(el, { pointerId: 1 }) })

    expect(useAssemblyStore.getState().manipulation).toBeNull()
    expect(useAssemblyStore.getState().gizmoDrag).toBeNull()
  })
})

describe('AssemblyViewport pointer lifecycle branches', () => {
  // Unmount mid-drag: the pointerup never arrives, and the session + published
  // gizmoDrag live outside React, so the wrapper's unmount effect must abandon
  // them or the next mount comes back camera-locked.
  it('unmounting mid-drag abandons the live manipulation and gizmoDrag', () => {
    seedAssembly()
    pipeline.resolveAllSync.mockImplementation(() => ([
      { layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gizmo:translate:x' },
    ]))
    const { container, unmount } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerDown(el, { button: 0, isPrimary: true, pointerId: 1, clientX: 32, clientY: 32 }) })
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()

    act(() => { unmount() })

    expect(useAssemblyStore.getState().manipulation).toBeNull()
    expect(useAssemblyStore.getState().gizmoDrag).toBeNull()
  })

  // Pointer-leave must tear the hover down: the last hovered entity would
  // otherwise stay advertised while the pointer is off the pane.
  it('pointerLeave clears the hover hits and the hovered entity', () => {
    seedAssembly()
    const store = useAssemblyStore.getState()
    store.setHoverHits([{ id: 1, layer: FACE_LAYER_NAME, entityKey: 'part-1|face|0', distancePx: 0 }] as never, false)
    store.setHoveredEntity('part-1|face|0')

    const { container } = render(<AssemblyViewport />)
    const el = container.firstChild as Element

    act(() => { fireEvent.pointerMove(el, { clientX: 10, clientY: 10 }) })
    act(() => { fireEvent.pointerLeave(el) })

    expect(useAssemblyStore.getState().hoverHits).toEqual([])
    expect(useAssemblyStore.getState().hoveredEntity).toBeNull()
  })
})
