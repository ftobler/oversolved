/**
 * Layer-2 pick-field consumer tests. Verifies:
 * - isPicking only when activePickField matches this hook's featureId+field
 * - toggle activates/deactivates the field (mutual exclusion)
 * - new non-chip-owned item in normalSelection triggers onPick then clears
 * - multi fields stay open after one pick; single fields auto-close
 *
 * See feature/selection-unification.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'
import { usePickField } from '@/hooks/useFieldPicking'
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
  opts?: { multi?: boolean; onUnpick?: (id: string) => void },
) {
  function Spy() {
    const { isPicking, toggle } = usePickField(featureId, field, onPick, opts)
    return (
      <div>
        <span data-testid="spy-picking">{String(isPicking)}</span>
        <button data-testid="spy-toggle" onClick={toggle}>toggle</button>
      </div>
    )
  }
  const result = render(<Spy />)
  const getEl = (testId: string) => result.container.querySelector(`[data-testid="${testId}"]`)
  return {
    get isPicking(): boolean { return getEl('spy-picking')?.textContent === 'true' },
    toggle: () => { act(() => { fireEvent.click(getEl('spy-toggle')!) }) },
    unmount: result.unmount,
  }
}

describe('usePickField — mutual exclusion', () => {
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

    // Activate a different field — the first must see isPicking=false
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

describe('usePickField — consumer (Layer 2)', () => {
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
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'edges' })
      useSketchEditorStore.getState().syncChipSelection(['?body_ex1/edge/0'])
    })
    mountPickField('sk1', 'edges', onPick)

    // Toggle adds the same item that is already chip-owned → should not fire
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

describe('usePickField — re-click toggles off (unpick)', () => {
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

  it('does not fire onUnpick when no field option is supplied', () => {
    const onPick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'edges', multi: true })
      useSketchEditorStore.getState().syncChipSelection(['?body_ex1/edge/0'])
    })
    mountPickField('sk1', 'edges', onPick, { multi: true })

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?body_ex1/edge/0')
    })
    expect(onPick).not.toHaveBeenCalled()
    // Without an onUnpick handler the chip-owned mirror is left untouched.
    expect(useSketchEditorStore.getState().chipOwnedSelection.has('?body_ex1/edge/0')).toBe(true)
  })
})

describe('usePickField — auto-close (multi vs single)', () => {
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
})

describe('usePickField — toggle', () => {
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
})
