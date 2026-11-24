import { describe, it, expect, beforeEach } from 'vitest'
import {
  barFeatureIdAt,
  emptyDraft,
  isDraftEmpty,
  reportPick,
  useBugReportStore,
  type PickContext,
} from '@/stores/bugReportStore'
import { formatBugReportMarkdown } from '@/adapters/telemetry'
import { insertReference } from '@/utils/core/reportReferences'
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

  it('refuses a duplicate name and leaves state untouched', () => {
    const store = useBugReportStore.getState()
    store.addSet()
    store.addSet()
    const [first, second] = useBugReportStore.getState().sets
    useBugReportStore.getState().setText({ description: 'see #set1' })

    expect(useBugReportStore.getState().renameSet(second.id, 'set1')).toBe('name already used')
    expect(useBugReportStore.getState().sets[1].name).toBe('set2')
    expect(useBugReportStore.getState().description).toBe('see #set1')

    expect(useBugReportStore.getState().renameSet(first.id, '   ')).toBe('a set needs a name')
    expect(useBugReportStore.getState().sets[0].name).toBe('set1')
    expect(useBugReportStore.getState().description).toBe('see #set1')
  })

  // The name is free text: it is the user's label for the set, and a space is
  // carried by the bracketed reference form rather than refused.
  it('accepts a free-text name and trims it on commit', () => {
    const id = useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().renameSet(id, '  set 1  ')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('set 1')
    expect(useBugReportStore.getState().renameSet(id, 'set 1')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('set 1')
  })

  it('refuses a name of only whitespace', () => {
    const id = useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().renameSet(id, ' \t ')).toBe('a set needs a name')
    expect(useBugReportStore.getState().renameSet(id, '')).toBe('a set needs a name')
    expect(useBugReportStore.getState().sets[0].name).toBe('set1')
  })

  // A name is one line: a pasted newline or tab cannot break the exported
  // heading or the one-line token, so an interior whitespace run collapses.
  it('collapses an interior line break or tab into one space', () => {
    const id = useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().renameSet(id, 'a\nb')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('a b')
    expect(useBugReportStore.getState().renameSet(id, 'a\t\tb')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('a b')
    expect(useBugReportStore.getState().renameSet(id, ' line\none ')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('line one')
  })

  it('accepts Unicode letters and combining marks in a set name', () => {
    const id = useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().renameSet(id, 'Gehäuse')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('Gehäuse')
    expect(useBugReportStore.getState().renameSet(id, '面')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('面')
    expect(useBugReportStore.getState().renameSet(id, 'Geha\u0308use')).toBeNull()
    expect(useBugReportStore.getState().sets[0].name).toBe('Geha\u0308use')
  })

  it('refuses a name with no characters', () => {
    const id = useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().renameSet(id, '')).toBe('a set needs a name')
    expect(useBugReportStore.getState().sets[0].name).toBe('set1')
  })

  it('rewrites references when a set is renamed', () => {
    const store = useBugReportStore.getState()
    const id = store.addSet()
    useBugReportStore.getState().setText({ description: 'look at #set1 and #set10' })
    expect(useBugReportStore.getState().renameSet(id, 'before')).toBeNull()
    expect(useBugReportStore.getState().description).toBe('look at #before and #set10')
  })

  // A free-text name moves both written forms: the short `#set1` and a
  // hand-typed `#[set1]` both follow the rename, and the new form is chosen for
  // the name that lands.
  it('rewrites both reference forms when a set is renamed', () => {
    const store = useBugReportStore.getState()
    const id = store.addSet()
    useBugReportStore.getState().setText({ description: 'look at #set1, #[set1] and #set10' })
    expect(useBugReportStore.getState().renameSet(id, 'set 1')).toBeNull()
    expect(useBugReportStore.getState().description).toBe('look at #[set 1], #[set 1] and #set10')
    expect(useBugReportStore.getState().renameSet(id, 'set1')).toBeNull()
    expect(useBugReportStore.getState().description).toBe('look at #set1, #set1 and #set10')
  })

  // One flow through the layers the panel uses: the `#` button inserts the
  // token, a rename rewrites it, and the export links it. A bracket in the name
  // has to survive all three.
  it('carries a name with bracket escapes through insert, rename and export', () => {
    const id = useBugReportStore.getState().addSet()
    expect(useBugReportStore.getState().renameSet(id, 'a]b')).toBeNull()
    const inserted = insertReference('see here', 'a]b', 8, 8)
    useBugReportStore.getState().setText({ description: inserted.text })
    expect(useBugReportStore.getState().description).toBe('see here #[a\\]b]')

    expect(useBugReportStore.getState().renameSet(id, 'c]d')).toBeNull()
    expect(useBugReportStore.getState().description).toBe('see here #[c\\]d]')

    const state = useBugReportStore.getState()
    const md = formatBugReportMarkdown({
      title: 'boom',
      description: state.description,
      selectionSets: state.sets.map(set => ({
        name: set.name,
        picks: set.picks.map(pick => ({ ...pick })),
      })),
    })
    expect(md).toContain('[#\\[c\\]d\\]](#selection-set-c-d)')
    expect(md).toContain('<h2 id="selection-set-c-d">Selection set: c]d</h2>')
  })

  it('rewrites only whole Unicode references on rename', () => {
    const id = useBugReportStore.getState().addSet()
    useBugReportStore.getState().renameSet(id, 'Gehäuse')
    useBugReportStore.getState().setText({ description: 'look at #Gehäuse and #Gehäuse2' })
    expect(useBugReportStore.getState().renameSet(id, '面')).toBeNull()
    expect(useBugReportStore.getState().description).toBe('look at #面 and #Gehäuse2')
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

  // A fresh draft attaches the document but not the edit history; the count
  // stays at the usual five so ticking the box needs no second step.
  it('starts a fresh draft with the edit history unattached', () => {
    expect(useBugReportStore.getState().attachments).toEqual({
      doc: true,
      history: false,
      historyCount: 5,
    })
    expect(emptyDraft().attachments.history).toBe(false)
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
