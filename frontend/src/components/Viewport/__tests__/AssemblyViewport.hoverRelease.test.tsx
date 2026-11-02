// AssemblyViewport reads and writes hover state (hoverHits, hoveredEntity) in
// the module-level assembly store. Those fields are store-owned: they survive
// setSnapshot and resetTransientAssemblyState only clears them via the page's
// unmount cleanup, so the viewport must release them itself when it goes away.
// A hover left behind at unmount redraws anchor triads or a B-rep highlight
// immediately on remount, advertising a pick nothing is under.
//
// The heavy scene furniture is mocked away; what is under test is the
// component's own lifecycle against the real store, and its use of the shared
// HoverScheduler -- in particular the stale-buffer rule, which the part editor
// and the assembly must apply identically.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, fireEvent, act } from '@testing-library/react'
import { FACE_LAYER_NAME } from '@/picking'

const { pipeline, fakeGl } = vi.hoisted(() => {
  const canvas = {
    width: 64,
    height: 64,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 64, bottom: 64, width: 64, height: 64, toJSON() { return {} } }),
  }
  return {
    pipeline: {
      resolveAllSync: vi.fn(() => [] as unknown[]),
      isDirty: vi.fn(() => false),
      isDisposed: () => false,
    },
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
import { installPointerEventStub } from '@/testing/pointerEventStub'

// The MouseEvent-based stub keeps `buttons` on the fired event.
installPointerEventStub('')

// The scheduler defers the assembly's blocking readback into a frame. Flushing
// the queued frames by hand lets a test take two moves through the same
// scheduler without depending on real animation timing.
let frames: Array<() => void> = []
function flushFrames() {
  const callbacks = frames
  frames = []
  for (const cb of callbacks) cb()
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(() => cb(0))
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  pipeline.resolveAllSync.mockReset()
  pipeline.resolveAllSync.mockImplementation(() => [])
  pipeline.isDirty.mockReset()
  pipeline.isDirty.mockImplementation(() => false)
  const store = useAssemblyStore.getState()
  store.setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  store.clearHover()
  store.setHoveredEntity(null)
})

function move(container: HTMLElement) {
  const root = container.firstElementChild as HTMLElement
  act(() => {
    fireEvent.pointerMove(root, { clientX: 32, clientY: 32, buttons: 0 })
    flushFrames()
  })
}

describe('AssemblyViewport unmount releases the shared hover state', () => {
  it('clears hoverHits and hoveredEntity in the store on unmount', () => {
    const { unmount } = render(<AssemblyViewport />)
    act(() => {
      // The two shapes a hover can take: aiming-mode anchor hits and
      // selection-mode B-rep highlight.
      useAssemblyStore.getState().setHoverHits([{ entityKey: 'part-1|vertex|0' }], true)
      useAssemblyStore.getState().setHoveredEntity('part-1|face|1')
    })
    expect(useAssemblyStore.getState().hoverHits).toHaveLength(1)
    expect(useAssemblyStore.getState().hoveredEntity).toBe('part-1|face|1')

    // Navigate away with the cursor outside the pane: no pointer event ever
    // fires to clear the hover, so the unmount cleanup is the last writer.
    unmount()

    expect(useAssemblyStore.getState().hoverHits).toEqual([])
    expect(useAssemblyStore.getState().hoveredEntity).toBeNull()
  })
})

describe('AssemblyViewport hover through a rebuilding id buffer', () => {
  it('keeps the hover when the empty hit lands on a dirty buffer', () => {
    pipeline.resolveAllSync.mockImplementation(() => [
      { layer: FACE_LAYER_NAME, entityKey: 'p1:body_0:face:2' },
    ])
    const { container } = render(<AssemblyViewport />)
    move(container)
    expect(useAssemblyStore.getState().hoveredEntity).toBe('p1:body_0:face:2')

    // The geometry is rebuilding, so the buffer's answer means nothing yet.
    pipeline.resolveAllSync.mockImplementation(() => [])
    pipeline.isDirty.mockImplementation(() => true)
    move(container)
    expect(useAssemblyStore.getState().hoveredEntity).toBe('p1:body_0:face:2')
  })

  it('releases the hover on an empty hit from a clean buffer', () => {
    pipeline.resolveAllSync.mockImplementation(() => [
      { layer: FACE_LAYER_NAME, entityKey: 'p1:body_0:face:2' },
    ])
    const { container } = render(<AssemblyViewport />)
    move(container)
    expect(useAssemblyStore.getState().hoveredEntity).toBe('p1:body_0:face:2')

    pipeline.resolveAllSync.mockImplementation(() => [])
    move(container)
    expect(useAssemblyStore.getState().hoveredEntity).toBeNull()
  })
})

describe('AssemblyViewport overlay stacking pen', () => {
  it('isolates the viewport root so a DOM overlay cannot outrank dialogs', () => {
    // The same pen the part Viewport needs, held here so it stays true: the
    // assembly scene draws its overlays in-canvas today, but a drei `<Html>`
    // added to it would portal beside the canvas with a z-index in the
    // millions and paint over the app's dialogs (z-index 9999).
    const { container } = render(<AssemblyViewport />)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.isolation).toBe('isolate')
  })
})
