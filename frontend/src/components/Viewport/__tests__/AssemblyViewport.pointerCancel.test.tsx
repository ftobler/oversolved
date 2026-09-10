// L29 review-17 regression: pointercancel closed the drag session but left the
// click-gesture tracker open, so correctness rested on an up always following a
// down. When the browser tears a gesture away no up comes: the stale origin
// then pairs with the NEXT release, or feeds onPointerMissed a stationary-click
// verdict from a gesture that was cancelled -- wiping the selection over a
// touch that turned into a scroll. Mirrors the part editor's cancel handling.
//
// The scene furniture is mocked away; what is under test is the wrapper's
// pointer wiring against the real gesture tracker and store.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'

const missedFn = vi.hoisted(() => ({ current: null as (() => void) | null }))

vi.mock('@react-three/fiber', () => ({
  // Capture the miss handler so the test can fire it the way R3F would after
  // a click that hit no geometry.
  Canvas: (props: { onPointerMissed?: () => void }) => {
    missedFn.current = props.onPointerMissed ?? null
    return null
  },
}))

vi.mock('@react-three/drei', async () => {
  const THREE = await import('three')
  return {
    Environment: () => null,
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

// jsdom has no PointerEvent constructor, so fireEvent.pointer* would degrade to
// a plain Event and drop button/isPrimary. Scoped to this file only.
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

describe('AssemblyViewport pointercancel closes the pending click gesture', () => {
  beforeEach(() => {
    const store = useAssemblyStore.getState()
    store.setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    store.clearHover()
    store.setHoveredEntity(null)
    useAssemblyStore.setState({ entitySelection: seededSelection(), subject: null })
    missedFn.current = null
  })

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
})
