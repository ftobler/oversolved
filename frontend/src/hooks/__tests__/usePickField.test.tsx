/**
 * Layer-2 pick-field consumer tests. Verifies:
 * - isPicking only when activePickField matches this hook's featureId+field
 * - toggle activates/deactivates the field (mutual exclusion)
 * - new non-chip-owned item in normalSelection triggers onPick then clears
 * - multi fields stay open after one pick; single fields auto-close
 * - one arriving batch is planned against the field's held identities: a click
 *   on a held identity removes it, a lasso only adds, each identity once
 * - a refusal keeps the chip-owned highlight mirror (backlog regression)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'
import { usePickField } from '@/hooks/usePickField'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
import { useEditorState } from '@/hooks/useEditorState'
import { partsWantKey, type WantKeyOf } from '@/utils/query/pickIntake'
import { EXTRUDE_SCHEMA } from '@/components/editors/featureEditorSchemas'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'
import { makeAncestryQuery } from '@/kernel/query'
import type { PartFeature, PartResult } from '@/types/cad'

const part = (id: string, createdBy: string): PartResult => ({ id, created_by: createdBy, modified_by: [] })
const PARTS: Record<string, PartResult> = {
  body_ex1: part('body_ex1', 'ex1'),
  body_ex2: part('body_ex2', 'ex2'),
}

beforeEach(() => {
  useEditorState.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    activeTool: null,
    modeStack: [],
  })
  useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
})

/** Minimal render-helper that mounts a component to exercise the hook. */
function mountPickField(
  featureId: string,
  field: string,
  onPick: (id: string) => void,
  opts?: {
    multi?: boolean
    onUnpick?: (id: string) => void
    features?: readonly PartFeature[]
    validatePick?: (id: string) => string | null
    held?: readonly string[]
    wantKeyOf?: WantKeyOf
    labelOf?: (heldValue: string) => string
    onPickBatch?: (intake: { add: string[]; remove: number[] }) => void
  },
) {
  function Spy() {
    const { isPicking, toggle, activate, refusal } = usePickField(featureId, field, onPick, opts)
    return (
      <div>
        <span data-testid="spy-picking">{String(isPicking)}</span>
        <span data-testid="spy-refusal">{refusal.message}</span>
        <button data-testid="spy-toggle" onClick={toggle}>toggle</button>
        <button data-testid="spy-activate" onClick={activate}>activate</button>
      </div>
    )
  }
  const result = render(<Spy />)
  const getEl = (testId: string) => result.container.querySelector(`[data-testid="${testId}"]`)
  return {
    get isPicking(): boolean { return getEl('spy-picking')?.textContent === 'true' },
    get refusal(): string { return getEl('spy-refusal')?.textContent ?? '' },
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
    const features: PartFeature[] = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'sk2', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
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
    const features: PartFeature[] = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
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

  it('single field drops a field-rule-rejected pick but stays open', () => {
    // The field's own validatePick refusal follows the same policy as the
    // build-order one: no mutation, no disarm. The helix reference field is the
    // single-pick field with a rule today (a face pick is refused there).
    const onPick = vi.fn()
    const validatePick = (id: string) => (id.includes(':flatface') ? 'a helix sits on a cylinder face, a circular edge or a circle' : null)
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'hx1', field: 'reference' })
    })
    mountPickField('hx1', 'reference', onPick, { validatePick })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set(['?9;@body_ex1:flatface']))
    })

    expect(onPick).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()

    // The field is still live: the next pick that passes the rule lands.
    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set(['?9;@body_ex1:cylinderface']))
    })
    expect(onPick).toHaveBeenCalledWith('?9;@body_ex1:cylinderface')
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })

  it('multi field skips a field-rule-rejected id and keeps consuming the box', () => {
    const onPick = vi.fn()
    const validatePick = (id: string) => (id.endsWith(':flatface') ? null : 'pick a face')
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'mf1', field: 'faces', multi: true })
    })
    mountPickField('mf1', 'faces', onPick, { multi: true, validatePick })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(
        new Set(['?9;@body_ex1:cylinderface', '?9;@body_ex1:flatface']),
      )
    })

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('?9;@body_ex1:flatface')
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()
  })
})

describe('usePickField  -  refusal reason', () => {
  it('returns the reason instead of raising a toast, and clears it on an accepted pick', () => {
    // The hook owns no notification: the reason comes back for the editor to
    // render next to the field it explains.
    const onPick = vi.fn()
    const validatePick = (id: string) => (id.endsWith(':flatface') ? null : 'pick a face')
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'mf1', field: 'faces', multi: true })
    })
    const spy = mountPickField('mf1', 'faces', onPick, { multi: true, validatePick })

    act(() => { useSketchEditorStore.getState().setNormalSelection(new Set(['?9;@body_ex1:cylinderface'])) })
    expect(spy.refusal).toBe('Pick refused: pick a face')

    act(() => { useSketchEditorStore.getState().setNormalSelection(new Set(['?9;@body_ex1:flatface'])) })
    expect(spy.refusal).toBe('')
  })

  it('a box mixing good and bad picks still reports the first reason', () => {
    // Some boxed elements landed and some did not; the user is told why the
    // rest were left out.
    const onPick = vi.fn()
    const validatePick = (id: string) => (id.endsWith(':flatface') ? null : 'pick a face')
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'mf1', field: 'faces', multi: true })
    })
    const spy = mountPickField('mf1', 'faces', onPick, { multi: true, validatePick })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set(['?9;@body_ex1:flatface', '@body_ex1/edge/2']))
    })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(spy.refusal).toBe('Pick refused: pick a face')
  })

  it('the reason is scoped to the field: switching fields or disarming hides it', () => {
    const onPick = vi.fn()
    const features: PartFeature[] = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    ]
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'edges' })
    })
    const spy = mountPickField('ex1', 'edges', onPick, { features })

    act(() => { useSketchEditorStore.getState().setNormalSelection(new Set(['@body_ex1'])) })
    expect(spy.refusal).toBe('Pick refused: can only reference earlier features')

    act(() => { useSketchEditorStore.getState().setActivePickField(null) })
    expect(spy.refusal).toBe('')

    // Re-arming the same field does not resurrect the old reason.
    act(() => { useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'edges' }) })
    expect(spy.refusal).toBe('')
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

describe('usePickField  -  profile pick rule', () => {
  const SKETCH = {
    id: 'sk1',
    kind: 'sketch',
    label: 'Sketch 1',
    entities: [
      { id: 'l1', kind: 'line' },
      { id: 'l2', kind: 'line' },
      { id: 'l3', kind: 'line' },
      { id: 'l4', kind: 'line' },
    ],
  } as unknown as PartFeature
  const FEATURES: PartFeature[] = [SKETCH]
  const profileField = EXTRUDE_SCHEMA.fields.find(
    (field): field is PickFieldDef => field.type === 'pick' && field.key === 'sketch',
  )!

  it('a line click dispatches nothing, keeps the field armed and shows the sentence', () => {
    // The reported bug: the extrude profile accepted a line, then the build
    // refused it. The rule now refuses it at the chip, where the user can go
    // straight for the area fill beside it.
    const onPick = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'sketch', multi: true })
    })
    const spy = mountPickField('ex1', 'sketch', onPick, {
      multi: true,
      features: FEATURES,
      validatePick: profileField.validatePick,
    })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set(['entity:sk1:l1']))
    })

    expect(onPick).not.toHaveBeenCalled()
    expect(spy.isPicking).toBe(true)
    expect(spy.refusal).toBe(
      'Pick refused: a line has no area of its own; pick the area beside it, or a closed curve such as a circle',
    )
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)

    // The area fill the line borders is the very next click, and it lands.
    const area = makeAncestryQuery(['@sk1/l1', '@sk1/l2', '@sk1/l3', '@sk1/l4', 'surface:0', '@sk1'], 'flatface')
    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set([area]))
    })
    expect(onPick).toHaveBeenCalledWith(area)
  })
})

describe('usePickField  -  want-keyed intake', () => {
  it('a click naming a held part through another face removes the held value', () => {
    // The user's rule: a second edge of an already-picked part is the removal
    // pick for the part, not another edge chip.
    const onPick = vi.fn()
    const onPickBatch = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'db1', field: 'bodies', multi: true })
      useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0'])
    })
    mountPickField('db1', 'bodies', onPick, {
      multi: true,
      held: ['@body_ex1/face/0'],
      wantKeyOf: partsWantKey(PARTS),
      onPickBatch,
    })

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@body_ex1/face/1')
    })

    expect(onPickBatch).toHaveBeenCalledWith({ add: [], remove: [0] })
    expect(onPick).not.toHaveBeenCalled()
    // The single field stays armed: a click in a multi field consumes only its
    // own batch.
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()
  })

  it('a lasso is one batch call and lands a part once', () => {
    const onPick = vi.fn()
    const onPickBatch = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'db1', field: 'bodies', multi: true })
    })
    mountPickField('db1', 'bodies', onPick, {
      multi: true,
      held: [],
      wantKeyOf: partsWantKey(PARTS),
      onPickBatch,
    })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set([
        '@body_ex1/face/0', '@body_ex1/face/1', '@body_ex2/edge/0',
      ]))
    })

    expect(onPickBatch).toHaveBeenCalledTimes(1)
    expect(onPickBatch).toHaveBeenCalledWith({
      add: ['@body_ex1/face/0', '@body_ex2/edge/0'], remove: [],
    })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a lasso only adds: a held part is skipped, never removed', () => {
    const onPickBatch = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'db1', field: 'bodies', multi: true })
    })
    mountPickField('db1', 'bodies', vi.fn(), {
      multi: true,
      held: ['@body_ex1/face/0'],
      wantKeyOf: partsWantKey(PARTS),
      onPickBatch,
    })

    act(() => {
      useSketchEditorStore.getState().setNormalSelection(new Set([
        '@body_ex1/face/1', '@body_ex2/edge/0',
      ]))
    })

    expect(onPickBatch).toHaveBeenCalledWith({ add: ['@body_ex2/edge/0'], remove: [] })
  })

  it('a chip-owned drop removes the value by its index through the batch', () => {
    const onPickBatch = vi.fn()
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'db1', field: 'bodies', multi: true })
      useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0', '@body_ex2/face/0'])
    })
    mountPickField('db1', 'bodies', vi.fn(), {
      multi: true,
      held: ['@body_ex1/face/0', '@body_ex2/face/0'],
      wantKeyOf: partsWantKey(PARTS),
      onPickBatch,
    })

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@body_ex2/face/0')
    })

    expect(onPickBatch).toHaveBeenCalledWith({ add: [], remove: [1] })
  })
})

describe('usePickField  -  a refusal keeps the chip mirror', () => {
  it('drops only the refused pick, leaving the chip-owned entries selected', () => {
    // Backlog regression: a refusal used to clearNormalSelection, which also
    // emptied chipOwnedSelection and left the chip unlit.
    const onPick = vi.fn()
    const validatePick = (id: string) => (id.endsWith(':flatface') ? null : 'pick a face')
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'mf1', field: 'faces', multi: true })
      useSketchEditorStore.getState().syncChipSelection(['?9;@body_ex1:flatface'])
    })
    const spy = mountPickField('mf1', 'faces', onPick, { multi: true, validatePick })

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?9;@body_ex1:cylinderface')
    })

    expect(onPick).not.toHaveBeenCalled()
    expect(spy.refusal).toBe('Pick refused: pick a face')
    const state = useSketchEditorStore.getState()
    expect([...state.normalSelection]).toEqual(['?9;@body_ex1:flatface'])
    expect([...state.chipOwnedSelection]).toEqual(['?9;@body_ex1:flatface'])
    expect(state.activePickField).not.toBeNull()
  })
})


describe('usePickField  -  one armed pick', () => {
  it('arming a feature pick cancels an armed section pick', () => {
    // Both surfaces arm the same viewport click; they must never coexist.
    useSectionStore.setState({ enabled: true, picking: true })
    const spy = mountPickField('sk1', 'plane', vi.fn())

    spy.toggle()
    expect(useSectionStore.getState().picking).toBe(false)

    useSectionStore.getState().setPicking(true)
    spy.activate()
    expect(useSectionStore.getState().picking).toBe(false)
  })

  it('cancels the section from the store action every armer calls', () => {
    // Plane editors and the Add Feature buttons arm through setActivePickField
    // directly, bypassing the hook, so the rule has to live in the action.
    useSectionStore.setState({ enabled: true, picking: true })
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'faces' })
    })
    expect(useSectionStore.getState().picking).toBe(false)
  })

  it('leaves an armed section alone when a field is only disarmed', () => {
    // The section's own arm path calls setActivePickField(null) before setting
    // its pick; routine disarms must not cancel it.
    useSectionStore.setState({ enabled: true, picking: true })
    act(() => {
      useSketchEditorStore.getState().setActivePickField(null)
    })
    expect(useSectionStore.getState().picking).toBe(true)
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
