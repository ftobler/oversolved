/**
 * The bug report's pick chip is a plain pick-field consumer that happens to
 * carry a non-feature id. These tests pin the two halves the panel relies on:
 * the pick snapshot is taken at click time (bar, bar feature, open edit), and
 * moving the bar afterwards does not turn stored picks into unpicks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'
import { PickChip } from '@/components/sketch/PickChip'
import { useBugReportPick } from '@/hooks/useBugReportPick'
import { usePickField } from '@/hooks/usePickField'
import { assertEditingInvariant } from '@/hooks/useSolver'
import { useBugReportStore, type PickContext } from '@/stores/bugReportStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { validateSketchEditorState } from '@/stores/stateInvariants'
import type { PartFeature } from '@/types/cad'

const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1' },
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: '$sk1', distance: 10 } },
  { id: 'fi1', kind: 'fillet', label: 'Fillet 1', fillet: { edges: [], radius: 1 } },
]

const CTX: PickContext = {
  rollback: 2,
  barFeatureId: 'ex1',
  editingFeatureId: null,
  features: FEATURES,
  partLabels: {},
}

function seedSet(): string {
  useBugReportStore.getState().openReport([], CTX)
  return useBugReportStore.getState().addSet()
}

let setId = ''

function ReportHarness({ id }: { id: string }) {
  const set = useBugReportStore(s => s.sets.find(entry => entry.id === id))
  const pick = useBugReportPick(id)
  if (!set) return null
  return (
    <PickChip
      values={set.picks.map(p => p.query)}
      isPicking={pick.isPicking}
      onActivate={pick.toggle}
      onRemove={() => {}}
      features={FEATURES}
    />
  )
}

function FeatureHarness() {
  const pick = usePickField('ex1', 'edges', vi.fn(), { multi: true })
  return (
    <PickChip
      values={[]}
      isPicking={pick.isPicking}
      onActivate={pick.toggle}
      onRemove={() => {}}
    />
  )
}

function armChip(index = 0) {
  fireEvent.click(document.querySelectorAll('.feature-pick-chip')[index])
}

// The store merges a partial into the current state, so a spy installed for one
// test survives later updates; each test puts the real action back.
const realRemovePick = useBugReportStore.getState().removePick

beforeEach(() => {
  useBugReportStore.getState().discard()
  useBugReportStore.setState({ removePick: realRemovePick })
  usePartEditorStore.setState({ features: FEATURES, partLabels: {} })
  useEditorState.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    activeTool: null,
    modeStack: [],
    rollbackPosition: 2,
    editingFeatureId: null,
    pickBoundary: null,
  })
})

afterEach(() => {
  useBugReportStore.setState({ removePick: realRemovePick })
})

describe('useBugReportPick', () => {
  it('records the live bar, bar feature and open edit when a pick lands', () => {
    setId = seedSet()
    useEditorState.setState({ rollbackPosition: 2, editingFeatureId: 'ex1' })
    render(<ReportHarness id={setId} />)
    armChip()

    expect(useEditorState.getState().activePickField).toEqual({
      featureId: `bug-report:${setId}`,
      field: 'picks',
      multi: true,
    })

    act(() => { useEditorState.getState().toggleNormalSelection('@ex1') })

    const picks = useBugReportStore.getState().sets[0].picks
    expect(picks).toHaveLength(1)
    expect(picks[0]).toMatchObject({
      query: '@ex1',
      label: 'Extrude 1',
      rollback: 2,
      barFeatureId: 'ex1',
      editingFeatureId: 'ex1',
    })
  })

  it('lands every id of a rubber-band box', () => {
    setId = seedSet()
    render(<ReportHarness id={setId} />)
    armChip()

    act(() => {
      useEditorState.getState().setNormalSelection(new Set(['@a', '@b', '@c']))
    })

    expect(useBugReportStore.getState().sets[0].picks.map(p => p.query)).toEqual(['@a', '@b', '@c'])
  })

  it('removes a pick when an owned query is re-clicked', () => {
    setId = seedSet()
    render(<ReportHarness id={setId} />)
    armChip()
    act(() => { useEditorState.getState().toggleNormalSelection('@body_ex1') })
    expect(useBugReportStore.getState().sets[0].picks).toHaveLength(1)

    act(() => { useEditorState.getState().toggleNormalSelection('@body_ex1') })
    expect(useBugReportStore.getState().sets[0].picks).toEqual([])
  })

  // The core requirement: picks are records, not "what is visible now".
  it('keeps picks made at another rollback position and never unpicks them', () => {
    setId = seedSet()
    const removeSpy = vi.fn()
    act(() => { useBugReportStore.setState({ removePick: removeSpy }) })
    useEditorState.setState({ rollbackPosition: 5 })
    const view = render(<ReportHarness id={setId} />)
    armChip()

    act(() => { useEditorState.getState().toggleNormalSelection('@body_ex1') })
    expect(useBugReportStore.getState().sets[0].picks[0].rollback).toBe(5)

    act(() => {
      useEditorState.getState().setRollbackPosition(3)
      // The other half of moving the bar is the solve write-back. A shallow
      // store simulation is enough here because the assertion that matters is
      // the remove path: no onUnpick may fire while the bar moves.
      usePartEditorStore.setState({ solveResults: { sk1: { solved: {} } } })
    })
    act(() => { useEditorState.getState().toggleNormalSelection('@body_sk1') })
    act(() => { useEditorState.getState().setRollbackPosition(5) })

    const picks = useBugReportStore.getState().sets[0].picks
    expect(picks.map(p => [p.query, p.rollback])).toEqual([
      ['@body_ex1', 5],
      ['@body_sk1', 3],
    ])
    expect(removeSpy).not.toHaveBeenCalled()

    // Sanity check that the spy is the hook's actual onUnpick: a deliberate
    // re-click must reach it, so the no-call assertion above is meaningful.
    act(() => { useEditorState.getState().toggleNormalSelection('@body_ex1') })
    expect(removeSpy).toHaveBeenCalledWith(setId, '@body_ex1')
    view.unmount()
  })

  it('accepts a pick that names any feature, with no build-order rule', () => {
    // `features` is deliberately not passed to usePickField: a report may
    // reference the feature the user is looking at, including a later one.
    setId = seedSet()
    usePartEditorStore.setState({
      features: [...FEATURES, { id: 'ex2', kind: 'extrude', label: 'Extrude 2', extrude: { sketch: '$sk1', distance: 5 } }],
    })
    render(<ReportHarness id={setId} />)
    armChip()
    act(() => { useEditorState.getState().toggleNormalSelection('@body_ex2') })
    expect(useBugReportStore.getState().sets[0].picks.map(p => p.query)).toEqual(['@body_ex2'])
  })

  it('keeps the single armed pick field invariant with a feature chip', () => {
    setId = seedSet()
    render(
      <>
        <ReportHarness id={setId} />
        <FeatureHarness />
      </>,
    )

    armChip(0)
    expect(useEditorState.getState().activePickField?.featureId).toBe(`bug-report:${setId}`)
    expect(() => validateSketchEditorState(useEditorState.getState())).not.toThrow()

    armChip(1)
    expect(useEditorState.getState().activePickField?.featureId).toBe('ex1')
    expect(() => validateSketchEditorState(useEditorState.getState())).not.toThrow()

    armChip(0)
    expect(useEditorState.getState().activePickField?.featureId).toBe(`bug-report:${setId}`)
    expect(useEditorState.getState().modeStack).toEqual(['pick'])
    expect(() => validateSketchEditorState(useEditorState.getState())).not.toThrow()
  })

  it('leaves the edit FSM untouched while a feature edit is open', () => {
    setId = seedSet()
    useEditorState.setState({ rollbackPosition: 2, editingFeatureId: 'ex1', pickBoundary: 1 })
    render(<ReportHarness id={setId} />)
    armChip()
    act(() => { useEditorState.getState().toggleNormalSelection('@body_ex1') })

    expect(useBugReportStore.getState().sets[0].picks[0].editingFeatureId).toBe('ex1')
    // The report never writes pickBoundary; the open edit's invariant stays as
    // the editor left it.
    const state = useEditorState.getState()
    expect(state.pickBoundary).toBe(1)
    expect(state.editingFeatureId).toBe('ex1')
    expect(() => assertEditingInvariant(
      state.editingFeatureId,
      FEATURES,
      state.rollbackPosition ?? FEATURES.length,
      state.pickBoundary,
    )).not.toThrow()
  })

  it('disarms its own field when the set row unmounts', () => {
    setId = seedSet()
    const { unmount } = render(<ReportHarness id={setId} />)
    armChip()
    expect(useEditorState.getState().activePickField?.featureId).toBe(`bug-report:${setId}`)

    unmount()
    expect(useEditorState.getState().activePickField).toBeNull()
    expect(useEditorState.getState().modeStack).toEqual([])
  })

  it('leaves an unrelated armed field alone on unmount', () => {
    setId = seedSet()
    const { unmount } = render(<ReportHarness id={setId} />)
    act(() => {
      useEditorState.getState().setActivePickField({ featureId: 'ex1', field: 'edges', multi: true })
    })

    unmount()
    expect(useEditorState.getState().activePickField).toEqual({
      featureId: 'ex1',
      field: 'edges',
      multi: true,
    })
  })
})
