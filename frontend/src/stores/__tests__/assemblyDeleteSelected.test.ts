// T2: the one selection subject and the one delete path. The store owns both
// decisions so the logic is testable without the viewport or the page's React
// state, the same contract the manipulation state machine keeps.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc, AssemblyFeature, MateFeatureDef, PartInstance } from '@/types/cad'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { readSelection } from '@/utils/assemblySelection'
import { EMPTY_MATE_REF } from '@/utils/mateKinds'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function inst(handle: string): PartInstance {
  return { handle, doc_id: `d-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true }
}

function mate(refA: string, refB: string): MateFeatureDef {
  return {
    kind: 'fixed',
    ref_a: { ...EMPTY_MATE_REF, part: refA },
    ref_b: { ...EMPTY_MATE_REF, part: refB },
  }
}

// Two parts and one mate that references both, the smallest doc that exercises
// the no-cascade contract when a referenced part is deleted.
function sampleDoc(): AssemblyDoc {
  return {
    kind: 'assembly',
    features: [
      { id: 'fp1', kind: 'part_instance', instance: inst('h1') },
      { id: 'fp2', kind: 'part_instance', instance: inst('h2') },
      { id: 'fm1', kind: 'mate', mate: mate('h1', 'h2') },
    ],
  }
}

function ids(doc: AssemblyDoc, kind: AssemblyFeature['kind']): string[] {
  return (doc.features ?? []).filter(f => f.kind === kind).map(f => f.id)
}

/** The one accessor every production reader uses, applied to the live store. */
function readSelectionOfStore() {
  const state = useAssemblyStore.getState()
  return readSelection(state.subject, state.entitySelection)
}

/** Stands in for the AssemblyEditor: owns the doc, counts re-solves. */
function mountHost(initial: AssemblyDoc) {
  const requestSolve = vi.fn()
  const host = { doc: initial }
  setAssemblyCallbacks({
    mutateDoc: (_label, fn) => { host.doc = fn(host.doc) },
    mutateDocSession: (_label, fn) => { host.doc = fn(host.doc) },
    requestSolve,
  })
  useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial })
  return { host, requestSolve }
}

describe('assemblyStore selection subject', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ subject: null })
    setAssemblyCallbacks(null)
  })

  it('selecting a part clears a previously selected mate', () => {
    mountHost(sampleDoc())
    const store = useAssemblyStore.getState()
    store.selectMate('fm1')
    store.selectPart('h1')

    const view = readSelectionOfStore()
    expect(view.mate).toBeNull()
    expect(view.parts).toEqual(new Set(['h1']))
  })

  it('selecting a mate clears a previously selected part', () => {
    mountHost(sampleDoc())
    const store = useAssemblyStore.getState()
    store.selectPart('h1')
    store.selectMate('fm1')

    const view = readSelectionOfStore()
    expect(view.parts.size).toBe(0)
    expect(view.mate).toBe('fm1')
  })

  it('clearing with null clears the one subject', () => {
    mountHost(sampleDoc())
    const store = useAssemblyStore.getState()
    store.selectPart('h1')
    store.selectPart(null)
    expect(useAssemblyStore.getState().subject).toBeNull()

    store.selectMate('fm1')
    store.selectMate(null)
    expect(useAssemblyStore.getState().subject).toBeNull()
  })
})

describe('assemblyStore deleteSelected', () => {
  beforeEach(() => {
    // setSnapshot preserves store-owned fields (selection included), so the
    // selection has to be cleared directly or it leaks between tests.
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ subject: null })
    setAssemblyCallbacks(null)
  })

  it('deletes the selected mate, clears the selection and re-solves', () => {
    const { host, requestSolve } = mountHost(sampleDoc())
    useAssemblyStore.getState().selectMate('fm1')

    useAssemblyStore.getState().deleteSelected()

    expect(ids(host.doc, 'mate')).toEqual([])
    expect(ids(host.doc, 'part_instance')).toEqual(['fp1', 'fp2'])
    expect(useAssemblyStore.getState().subject).toBeNull()
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('deletes the selected part, clears the selection and re-solves', () => {
    const { host, requestSolve } = mountHost(sampleDoc())
    useAssemblyStore.getState().selectPart('h1')

    useAssemblyStore.getState().deleteSelected()

    expect(ids(host.doc, 'part_instance')).toEqual(['fp2'])
    expect(useAssemblyStore.getState().subject).toBeNull()
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('leaves a mate referencing the deleted part in place (no cascade; it goes stale at solve)', () => {
    const { host } = mountHost(sampleDoc())
    useAssemblyStore.getState().selectPart('h1')

    useAssemblyStore.getState().deleteSelected()

    // The mate survives with its now-dangling ref_a; the solver reports it stale.
    expect(ids(host.doc, 'mate')).toEqual(['fm1'])
    const survived = host.doc.features!.find(f => f.kind === 'mate')!.mate!
    expect(survived.ref_a.part).toBe('h1')
  })

  it('deletes the one subject and nothing else', () => {
    // A part selected: the part goes and the mate survives.
    {
      const { host } = mountHost(sampleDoc())
      useAssemblyStore.getState().selectPart('h1')
      useAssemblyStore.getState().deleteSelected()
      expect(ids(host.doc, 'part_instance')).toEqual(['fp2'])
      expect(ids(host.doc, 'mate')).toEqual(['fm1'])
    }
    // A mate selected: the mate goes and both parts survive.
    {
      useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
      useAssemblyStore.setState({ subject: null })
      const { host } = mountHost(sampleDoc())
      useAssemblyStore.getState().selectMate('fm1')
      useAssemblyStore.getState().deleteSelected()
      expect(ids(host.doc, 'mate')).toEqual([])
      expect(ids(host.doc, 'part_instance')).toEqual(['fp1', 'fp2'])
    }
  })

  it('is a no-op with nothing selected', () => {
    const { host, requestSolve } = mountHost(sampleDoc())

    useAssemblyStore.getState().deleteSelected()

    expect(host.doc).toEqual(sampleDoc())
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('routes a mate delete through selectMate, clearing a dangling armed field', () => {
    const { host, requestSolve } = mountHost(sampleDoc())
    useAssemblyStore.getState().selectMate('fm1')
    // A mate field is armed against the very mate now selected for deletion.
    useAssemblyStore.getState().setActiveMateField({ featureId: 'fm1', field: 'ref_a' })
    expect(useAssemblyStore.getState().activeMateField).not.toBeNull()

    useAssemblyStore.getState().deleteSelected()

    expect(ids(host.doc, 'mate')).toEqual([])
    // The delete must not bypass selectMate: the armed field that pointed at the
    // deleted mate would otherwise be left dangling.
    expect(useAssemblyStore.getState().subject).toBeNull()
    expect(useAssemblyStore.getState().activeMateField).toBeNull()
    expect(requestSolve).toHaveBeenCalled()
  })

  it('the [Delete] path and the row path are the same implementation', () => {
    // The [Delete] key: select, then deleteSelected.
    const viaKey = mountHost(sampleDoc())
    useAssemblyStore.getState().selectMate('fm1')
    useAssemblyStore.getState().deleteSelected()
    const keyDoc = viaKey.host.doc
    const keySolves = viaKey.requestSolve.mock.calls.length

    // The row button: deleteSubject directly.
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ subject: null })
    const viaRow = mountHost(sampleDoc())
    useAssemblyStore.getState().deleteSubject({ kind: 'mate', id: 'fm1' })
    const rowDoc = viaRow.host.doc
    const rowSolves = viaRow.requestSolve.mock.calls.length

    expect(rowDoc).toEqual(keyDoc)
    expect(useAssemblyStore.getState().subject).toBeNull()
    expect(rowSolves).toBe(keySolves)
  })
})

// The editing subject is store-owned now, so its open/close/reconcile lifecycle
// is asserted here with no React in the picture.
describe('assemblyStore editingSubject', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ subject: null, editingSubject: { kind: 'none' } })
    setAssemblyCallbacks(null)
  })

  it('open actions replace rather than stack, and close returns to none', () => {
    useAssemblyStore.getState().openMateEditor('fm1')
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'mate', id: 'fm1' })
    useAssemblyStore.getState().openInstanceEditor('h1')
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'instance', handle: 'h1' })
    useAssemblyStore.getState().closeEditor()
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'none' })
  })

  it('deleteSelected closes the editor only when it names the deleted subject', () => {
    mountHost(sampleDoc())
    useAssemblyStore.getState().openInstanceEditor('h1')
    useAssemblyStore.getState().selectPart('h2')

    useAssemblyStore.getState().deleteSelected()

    // The edited h1 survived, so its editor stays open.
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'instance', handle: 'h1' })
  })

  it('deleteSelected closes the editor on the deleted subject', () => {
    mountHost(sampleDoc())
    useAssemblyStore.getState().openMateEditor('fm1')
    useAssemblyStore.getState().selectMate('fm1')

    useAssemblyStore.getState().deleteSelected()

    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'none' })
  })

  it('setSnapshot clears the editing subject only when the new doc lacks it', () => {
    const { host } = mountHost(sampleDoc())
    useAssemblyStore.getState().openInstanceEditor('h1')

    // A doc that still has h1 keeps the editor open.
    useAssemblyStore.getState().setSnapshot({ ...useAssemblyStore.getState(), doc: host.doc })
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'instance', handle: 'h1' })

    // A doc without h1 retires it.
    const without = { ...host.doc, features: (host.doc.features ?? []).filter(f => f.id !== 'fp1') }
    useAssemblyStore.getState().setSnapshot({ ...useAssemblyStore.getState(), doc: without })
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'none' })
  })
})

// The subject union is the store invariant this feature introduces. Pin it at
// the store boundary: the two arms are exclusive, the union survives the
// React-mirrored snapshot, and the module-level default is never mutated.
describe('assemblyStore subject invariant', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ subject: null })
    setAssemblyCallbacks(null)
  })

  it('holds a tagged union with at most one arm populated', () => {
    useAssemblyStore.getState().selectPart('h1')
    expect(useAssemblyStore.getState().subject).toEqual({ kind: 'part', handle: 'h1' })
    useAssemblyStore.getState().selectMate('fm1')
    expect(useAssemblyStore.getState().subject).toEqual({ kind: 'mate', id: 'fm1' })
  })

  it('survives a setSnapshot round trip that names a different subject', () => {
    useAssemblyStore.getState().selectPart('h1')
    // The page rebuilds the snapshot from the document on every doc change; the
    // subject is store-owned, so the snapshot must not overwrite it.
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      subject: { kind: 'mate', id: 'ignored' },
    })
    expect(useAssemblyStore.getState().subject).toEqual({ kind: 'part', handle: 'h1' })
  })

  it('does not mutate the module-level default through reset or toggles', () => {
    expect(DEFAULT_ASSEMBLY_EDITOR_DATA.subject).toBeNull()
    useAssemblyStore.getState().toggleSelection('e1')
    useAssemblyStore.getState().resetTransientAssemblyState()
    // A reset hands back the default's own Set by reference; nothing in the
    // store may mutate it in place, or a later default would start non-empty.
    expect(DEFAULT_ASSEMBLY_EDITOR_DATA.entitySelection.size).toBe(0)
    expect(DEFAULT_ASSEMBLY_EDITOR_DATA.subject).toBeNull()

    // The actual hazard: after the reset the store holds the default's Set by
    // reference, so a subsequent toggle must copy rather than add in place.
    useAssemblyStore.getState().toggleSelection('e2')
    expect(useAssemblyStore.getState().entitySelection.has('e2')).toBe(true)
    expect(DEFAULT_ASSEMBLY_EDITOR_DATA.entitySelection.size).toBe(0)
    expect(DEFAULT_ASSEMBLY_EDITOR_DATA.entitySelection.has('e2')).toBe(false)
  })
})
