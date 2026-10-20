import { describe, it, expect, beforeEach } from 'vitest'
import {
  barFeatureIdAt,
  emptyDraft,
  isDraftEmpty,
  reportPick,
  useBugReportStore,
  type PickContext,
} from '@/stores/bugReportStore'
import type { PartFeature } from '@/types/cad'

const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1' },
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: '$sk1', distance: 10 } },
]

const CTX: PickContext = {
  rollback: 2,
  barFeatureId: 'ex1',
  editingFeatureId: null,
  features: FEATURES,
  partLabels: {},
}

beforeEach(() => {
  useBugReportStore.getState().discard()
})

describe('bug report draft store', () => {
  it('adds sets named set1, set2, and never reuses a used name or id', () => {
    const store = useBugReportStore.getState()
    store.addSet()
    store.addSet()
    const [first, second] = useBugReportStore.getState().sets
    expect([first.name, second.name]).toEqual(['set1', 'set2'])
    expect([first.id, second.id]).toEqual(['set-1', 'set-2'])

    // Renaming frees the live name but the draft has already used it.
    useBugReportStore.getState().renameSet(first.id, 'before')
    useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().sets.map(s => s.name)).toEqual(['before', 'set2', 'set3'])

    // Removing a set does not hand its identity to the next one either.
    useBugReportStore.getState().removeSet(second.id)
    useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().sets.map(s => s.name)).toEqual(['before', 'set3', 'set4'])
    expect(useBugReportStore.getState().sets.map(s => s.id)).toEqual(['set-1', 'set-3', 'set-4'])
  })

  it('refuses a duplicate or invalid name and leaves state untouched', () => {
    const store = useBugReportStore.getState()
    store.addSet()
    store.addSet()
    const [first, second] = useBugReportStore.getState().sets
    useBugReportStore.getState().setText({ description: 'see #set1' })

    expect(useBugReportStore.getState().renameSet(second.id, 'set1')).toBe('name already used')
    expect(useBugReportStore.getState().sets[1].name).toBe('set2')
    expect(useBugReportStore.getState().description).toBe('see #set1')

    expect(useBugReportStore.getState().renameSet(first.id, 'not allowed')).toBe('use letters, digits, - and _')
    expect(useBugReportStore.getState().sets[0].name).toBe('set1')
    expect(useBugReportStore.getState().description).toBe('see #set1')
  })

  it('rewrites references when a set is renamed', () => {
    const store = useBugReportStore.getState()
    const id = store.addSet()
    useBugReportStore.getState().setText({ description: 'look at #set1 and #set10' })
    expect(useBugReportStore.getState().renameSet(id, 'before')).toBeNull()
    expect(useBugReportStore.getState().description).toBe('look at #before and #set10')
  })

  it('seeds a selection set from a non-empty selection', () => {
    useBugReportStore.getState().openReport(['@ex1', '?9;@ex1:flatface'], CTX)
    const state = useBugReportStore.getState()
    expect(state.open).toBe(true)
    expect(state.sets).toHaveLength(1)
    expect(state.sets[0].name).toBe('selection')
    expect(state.sets[0].picks.map(p => p.query)).toEqual(['@ex1', '?9;@ex1:flatface'])
    expect(state.sets[0].picks[0]).toMatchObject({
      rollback: 2,
      barFeatureId: 'ex1',
      editingFeatureId: null,
      label: 'Extrude 1',
    })
  })

  it('seeds no set from an empty selection', () => {
    useBugReportStore.getState().openReport([], CTX)
    expect(useBugReportStore.getState().open).toBe(true)
    expect(useBugReportStore.getState().sets).toEqual([])
  })

  it('does not reseed an existing draft on reopen', () => {
    const store = useBugReportStore.getState()
    store.openReport(['@body_ex1'], CTX)
    store.close()
    useBugReportStore.getState().openReport(['@body_sk1'], CTX)
    expect(useBugReportStore.getState().sets.map(s => s.picks.map(p => p.query)))
      .toEqual([['@body_ex1']])
  })

  it('discard empties the draft, close keeps it', () => {
    const store = useBugReportStore.getState()
    store.openReport(['@body_ex1'], CTX)
    useBugReportStore.getState().setText({ title: 'Title', description: 'Body' })
    const id = useBugReportStore.getState().addSet()
    useBugReportStore.getState().addPick(id, reportPick('@body_ex1', CTX))

    useBugReportStore.getState().close()
    expect(useBugReportStore.getState().open).toBe(false)
    expect(useBugReportStore.getState().sets).toHaveLength(2)

    useBugReportStore.getState().discard()
    expect(useBugReportStore.getState()).toMatchObject(emptyDraft())
  })

  it('adds each query to a set once and removes it by query', () => {
    const id = useBugReportStore.getState().addSet()
    useBugReportStore.getState().addPick(id, reportPick('@body_ex1', CTX))
    useBugReportStore.getState().addPick(id, reportPick('@body_ex1', CTX))
    expect(useBugReportStore.getState().sets[0].picks).toHaveLength(1)
    useBugReportStore.getState().removePick(id, '@body_ex1')
    expect(useBugReportStore.getState().sets[0].picks).toEqual([])
  })

  it('reorders picks within a set', () => {
    const id = useBugReportStore.getState().addSet()
    for (const query of ['a', 'b', 'c']) {
      useBugReportStore.getState().addPick(id, reportPick(query, CTX))
    }
    useBugReportStore.getState().reorderPick(id, 0, 2)
    expect(useBugReportStore.getState().sets[0].picks.map(p => p.query)).toEqual(['b', 'c', 'a'])
  })

  it('clamps the history count to at least one', () => {
    useBugReportStore.getState().setAttachments({ historyCount: 0 })
    expect(useBugReportStore.getState().attachments.historyCount).toBe(1)
  })

  it('treats a typed title, description or a set as a non-empty draft', () => {
    expect(isDraftEmpty(useBugReportStore.getState())).toBe(true)
    useBugReportStore.getState().addSet()
    expect(isDraftEmpty(useBugReportStore.getState())).toBe(false)
  })

  it('reads the bar feature from the position before the bar', () => {
    expect(barFeatureIdAt(FEATURES, 2)).toBe('ex1')
    expect(barFeatureIdAt(FEATURES, 1)).toBe('sk1')
    expect(barFeatureIdAt(FEATURES, 0)).toBeNull()
    expect(barFeatureIdAt(FEATURES, null)).toBe('ex1')
  })
})
