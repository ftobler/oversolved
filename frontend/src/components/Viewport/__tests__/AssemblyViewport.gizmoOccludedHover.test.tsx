// M4: in plain selector mode `scheduleHover` split the triad handle off the
// front of the hit list and then highlighted `hits[0]` -- the entity the arrow
// is drawn over. A pointer-down on that pixel is claimed by the gizmo capture
// handler, so `gestureAllowsSelect` rejects the release and the click can never
// select it. Hover must treat a gizmo hit as an occluding claim, like the click
// path does: write `setHoveredEntity(null)` when `gizmoHit !== null`.
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
    pipeline: { resolveAllSync: vi.fn(() => [] as unknown[]), isDisposed: () => false },
    fakeGl: { domElement: canvas },
  }
})

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: unknown; onCreated?: (s: unknown) => void }) => {
    useEffect(() => { onCreated?.({ gl: fakeGl, scene: {} }) }, [onCreated])
    return children as React.ReactNode
  },
}))
vi.mock('@react-three/drei', () => ({ Environment: () => null }))
vi.mock('@/picking/IdPickingDriver', () => ({
  // Named so react-hooks/rules-of-hooks sees a component, not a bare `default`.
  default: function IdPickingDriverStub({ onReady }: { onReady?: (p: unknown) => void }) {
    useEffect(() => { onReady?.(pipeline) }, [onReady])
    return null
  },
}))
vi.mock('@/components/Viewport/SceneController', () => ({ default: () => null }))
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

// jsdom has no PointerEvent constructor, so fireEvent.pointer* would degrade to
// a plain Event and drop `buttons` (making scheduleHover read a held button and
// bail). Same shim the pointerCancel test uses.
if (typeof window.PointerEvent !== 'function') {
  window.PointerEvent = class PointerEventStub extends MouseEvent {
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      Object.defineProperty(this, 'pointerId', { value: init.pointerId ?? 0, enumerable: true })
    }
  } as unknown as typeof PointerEvent
}

// rAF runs synchronously so a single pointermove's hover resolve completes in
// the same tick.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  pipeline.resolveAllSync.mockReset()
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.getState().setHoveredEntity(null)
})

function move(container: HTMLElement) {
  const root = container.firstElementChild as HTMLElement
  act(() => { fireEvent.pointerMove(root, { clientX: 32, clientY: 32, buttons: 0 }) })
}

describe('AssemblyViewport gizmo-occluded hover', () => {
  it('does not set hoveredEntity to the entity behind a triad handle in selector mode', () => {
    pipeline.resolveAllSync.mockImplementation(() => [
      { layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gz:p1:x+' },
      { layer: FACE_LAYER_NAME, entityKey: 'p1:body_0:face:2' },
    ])
    const { container } = render(<AssemblyViewport />)
    move(container)
    expect(useAssemblyStore.getState().hoveredEntity).toBeNull()
  })

  it('still sets hoveredEntity when no gizmo handle is under the cursor', () => {
    pipeline.resolveAllSync.mockImplementation(() => [
      { layer: FACE_LAYER_NAME, entityKey: 'p1:body_0:face:2' },
    ])
    const { container } = render(<AssemblyViewport />)
    move(container)
    expect(useAssemblyStore.getState().hoveredEntity).toBe('p1:body_0:face:2')
  })

  it('aiming mode strips the gizmo hit and still resolves hover hits', () => {
    useAssemblyStore.setState({ activeMateField: { mateId: 'm1', field: 'a' } } as never)
    pipeline.resolveAllSync.mockImplementation(() => [
      { layer: GIZMO_HANDLE_LAYER_NAME, entityKey: 'gz:p1:x+' },
      { layer: FACE_LAYER_NAME, entityKey: 'p1:body_0:face:2' },
    ])
    const { container } = render(<AssemblyViewport />)
    move(container)
    const hits = useAssemblyStore.getState().hoverHits
    expect(hits.some(h => h.entityKey === 'gz:p1:x+')).toBe(false)
    expect(hits.some(h => h.entityKey === 'p1:body_0:face:2')).toBe(true)
  })
})
