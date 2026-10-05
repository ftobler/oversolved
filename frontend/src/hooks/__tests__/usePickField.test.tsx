/**
 * Layer-2 pick-field consumer tests. Verifies:
 * - isPicking only when activePickField matches this hook's featureId+field
 * - toggle activates/deactivates the field (mutual exclusion)
 * - new non-chip-owned item in normalSelection triggers onPick then clears
 * - multi fields stay open after one pick; single fields auto-close
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'
import { usePickField } from '@/hooks/usePickField'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    activeTool: null,
    modeStack: [],
  })
})

/** Minimal render-helper that mounts a component to exercise the hook. */
function mountPickField(
  featureId: string,
  field: string,
  onPick: (id: string) => void,
  opts?: { multi?: boolean; onUnpick?: (id: string) => void; features?: readonly { id: string }[] },
) {
  function Spy() {
    const { isPicking, toggle, activate } = usePickField(featureId, field, onPick, opts)
    return (
      <div>
        <span data-testid="spy-picking">{String(isPicking)}</span>
        <button data-testid="spy-toggle" onClick={toggle}>toggle</button>
        <button data-testid="spy-activate" onClick={activate}>activate</button>
      </div>
    )
  }
  const result = render(<Spy />)
  const getEl = (testId: string) => result.container.querySelector(`[data-testid="${testId}"]`)
  return {
    get isPicking(): boolean { return getEl('spy-picking')?.textContent === 'true' },
    toggle: () => { act(() => { fireEvent.click(getEl('spy-toggle')!) }) },
    activate: () => { act(() => { fireEvent.click(getEl('spy-activate')!) }) },
    unmount: result.unmount,
  }
}

describe('usePickField  -  mutual exclusion', () => {
  it('isPicking is true when activePickField matches', () => {
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    const spy = mountPickField('sk1', 'plane', vi.fn())
    expect(spy.isPicking).toBe(true)
  })

  it('isPicking is false when activePickField differs in featureId', () => {
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk2', field: 'plane' })
    })
    const spy = mountPickField('sk1', 'plane', vi.fn())
    expect(spy.isPicking).toBe(false)
  })

  it('isPicking is false when activePickField differs in field', () => {
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'edges' })
    })
    const spy = mountPickField('sk1', 'plane', vi.fn())
    expect(spy.isPicking).toBe(false)
  })

  it('isPicking is false when activePickField is null', () => {
    const spy = mountPickField('sk1', 'plane', vi.fn())
    expect(spy.isPicking).toBe(false)
  })

  it('setting a second activePickField deactivates the first (mutual exclusion)', () => {
    const onPickA = vi.fn()
    const spyA = mountPickField('sk1', 'plane', onPickA)

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    expect(spyA.isPicking).toBe(true)

    // Activate a different field, the first must see isPicking=false
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk2', field: 'edges' })
    })
    expect(spyA.isPicking).toBe(false)
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'sk2', field: 'edges' })

    // Toggling a selection now should NOT trigger spyA's onPick
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?body_ex1/edge/0')
    })
    expect(onPickA).not.toHaveBeenCalled()
  })
})

describe('usePickField  -  consumer (Layer 2)', () => {
  it('new non-chip-owned item in normalSelection triggers onPick then clears', () => {
    const onPick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    mountPickField('sk1', 'plane', onPick)

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    })

    expect(onPick).toHaveBeenCalledWith('@builtin_plane_top')
    expect(onPick).toHaveBeenCalledTimes(1)
    // normalSelection must be cleared after consumption.
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('does not fire onPick for items that are already chip-owned', () => {
    const onPick = vi.fn()
    const onUnpick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'edges' })
      useSketchEditorStore.getState().syncChipSelection(['?body_ex1/edge/0'])
    })
    mountPickField('sk1', 'edges', onPick, { onUnpick })

    // Toggling an already chip-owned item is a removal, never a new pick.
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?body_ex1/edge/0')
    })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('does not fire onPick when isPicking is false', () => {
    const onPick = vi.fn()
    mountPickField('sk1', 'plane', onPick)

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    })
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('usePickField  -  re-click toggles off (unpick)', () => {
  it('re-clicking an already-picked item fires onUnpick with that id', () => {
    const onPick = vi.fn()
    const onUnpick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'edges', multi: true })
      useSketchEditorStore.getState().syncChipSelection(['?body_ex1/edge/0', '?body_ex1/edge/1'])
    })
    mountPickField('sk1', 'edges', onPick, { multi: true, onUnpick })

    // Re-click edge/0 -> the viewport toggle removes it from normalSelection.
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?body_ex1/edge/0')
    })

    expect(onUnpick).toHaveBeenCalledWith('?body_ex1/edge/0')
    expect(onUnpick).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
    // Both selection sets are emptied until the chip re-syncs from fresh values.
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().chipOwnedSelection.size).toBe(0)
  })

  it('fails loud when a chip-owned drop has no onUnpick handler', () => {
    // The drop is a transient invariant violation only this hook can consume, so
    // a consumer that cannot is a wiring bug, not a silent no-op.
    const onPick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'edges', multi: true })
      useSketchEditorStore.getState().syncChipSelection(['?body_ex1/edge/0'])
    })
    mountPickField('sk1', 'edges', onPick, { multi: true })

    expect(() => {
      act(() => {
        useSketchEditorStore.getState().toggleNormalSelection('?body_ex1/edge/0')
      })
    }).toThrow('has no onUnpick handler')
    expect(onPick).not.toHaveBeenCalled()
    // The recovery runs before the report, so even the throwing mode leaves the
    // store consistent instead of bleeding an orphan into the next test.
    expect(useSketchEditorStore.getState().chipOwnedSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })
})

describe('usePickField  -  auto-close (multi vs single)', () => {
  it('single-pick field auto-closes after one pick', () => {
    const onPick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    mountPickField('sk1', 'plane', onPick)

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    })
    expect(onPick).toHaveBeenCalledOnce()
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })

  it('multi field stays open after picks', () => {
    const onPick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'edges', multi: true })
    })
    mountPickField('sk1', 'edges', onPick, { multi: true })

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?body_ex1/edge/0')
    })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?body_ex1/edge/1')
    })
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()
  })

  it('multi field consumes every boxed id, skipping build-order-rejected ones', () => {
    // A rubber-band box lands a Set wholesale (useRubberBandSelect commits
    // setNormalSelection(new Set(keys))). The boxed ex1's own body sits in the
    // middle to prove a rejected id is skipped without aborting the loop, so
    // the two earlier sketch picks still land.
    const onPick = vi.fn()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'sk2', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ]
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'edges', multi: true })
    })
    mountPickField('ex1', 'edges', onPick, { multi: true, features })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set(['@body_ex1', '@sk1', '@sk2']))
    })

    expect(onPick).toHaveBeenCalledTimes(2)
    expect(onPick).toHaveBeenNthCalledWith(1, '@sk1')
    expect(onPick).toHaveBeenNthCalledWith(2, '@sk2')
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()
  })

  it('single field drops a build-order-rejected pick but stays open', () => {
    // A refused pick must not consume the field: the user has to be able to go
    // straight for valid geometry, so unlike an accepted single pick the field
    // stays armed.
    const onPick = vi.fn()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ]
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'edges' })
    })
    mountPickField('ex1', 'edges', onPick, { features })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set(['@body_ex1']))
    })

    expect(onPick).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()
  })

  it('single field still takes only the first boxed id', () => {
    // Single fields keep the first-id behavior: the rest of a box is dropped.
    const onPick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    mountPickField('sk1', 'plane', onPick)

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set(['@builtin_plane_top', '@builtin_plane_front']))
    })

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('@builtin_plane_top')
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })
})

describe('usePickField  -  toggle', () => {
  it('toggle activates the field when it is not active', () => {
    const spy = mountPickField('sk1', 'plane', vi.fn())
    expect(spy.isPicking).toBe(false)

    spy.toggle()
    expect(spy.isPicking).toBe(true)
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'sk1', field: 'plane', multi: false })
  })

  it('toggle deactivates the field when it is currently active', () => {
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    const spy = mountPickField('sk1', 'plane', vi.fn())
    expect(spy.isPicking).toBe(true)

    spy.toggle()
    expect(spy.isPicking).toBe(false)
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })

  it('activate arms the field unconditionally and stays armed when called again', () => {
    // Unlike toggle, activate is the re-arm path a chip uses after a value is
    // removed, so it must arm even from an idle state and be idempotent.
    const spy = mountPickField('sk1', 'plane', vi.fn())
    expect(spy.isPicking).toBe(false)

    spy.activate()
    expect(spy.isPicking).toBe(true)
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'sk1', field: 'plane', multi: false })

    spy.activate()
    expect(spy.isPicking).toBe(true)
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'sk1', field: 'plane', multi: false })
  })
})
