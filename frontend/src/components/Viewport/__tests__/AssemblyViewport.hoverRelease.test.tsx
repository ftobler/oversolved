// AssemblyViewport reads and writes hover state (hoverHits, hoveredEntity) in
// the module-level assembly store. Those fields are store-owned: they survive
// setSnapshot and resetTransientAssemblyState only clears them via the page's
// unmount cleanup, so the viewport must release them itself when it goes away.
// A hover left behind at unmount redraws anchor triads or a B-rep highlight
// immediately on remount, advertising a pick nothing is under.
//
// The heavy scene furniture is mocked away; what is under test is the
// component's own lifecycle against the real store.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'

vi.mock('@react-three/fiber', () => ({
  Canvas: () => null,
}))

vi.mock('@react-three/drei', async () => {
  const THREE = await import('three')
  return {
    Environment: () => null,
    // SceneController imports this at module scope; it never renders here.
    OrbitControls: () => {
      void THREE
      return null
    },
  }
})

vi.mock('@/components/misc/CubeGizmo', () => ({
  CubeGizmoCanvas: () => null,
}))

import AssemblyViewport from '../AssemblyViewport'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

describe('AssemblyViewport unmount releases the shared hover state', () => {
  beforeEach(() => {
    const store = useAssemblyStore.getState()
    store.setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    store.clearHover()
    store.setHoveredEntity(null)
  })

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
