// Feature A: the [Delete] key removes the selected mate or part. The store owns
// the decision (deleteSelected) so the logic is testable without the viewport or
// the page's React state, the same contract the manipulation state machine keeps.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc, AssemblyFeature, MateFeatureDef, PartInstance } from '@/types/cad'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
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

describe('assemblyStore deleteSelected', () => {
  beforeEach(() => {
    // setSnapshot preserves store-owned fields (selection included), so the
    // selection has to be cleared directly or it leaks between tests.
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ selectedPartHandle: null, selectedMateId: null })
    setAssemblyCallbacks(null)
  })

  it('deletes the selected mate, clears the selection and re-solves', () => {
    const { host, requestSolve } = mountHost(sampleDoc())
    useAssemblyStore.getState().setSelectedMateId('fm1')

    useAssemblyStore.getState().deleteSelected()

    expect(ids(host.doc, 'mate')).toEqual([])
    expect(ids(host.doc, 'part_instance')).toEqual(['fp1', 'fp2'])
    expect(useAssemblyStore.getState().selectedMateId).toBeNull()
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('deletes the selected part, clears the selection and re-solves', () => {
    const { host, requestSolve } = mountHost(sampleDoc())
    useAssemblyStore.getState().setSelectedPartHandle('h1')

    useAssemblyStore.getState().deleteSelected()

    expect(ids(host.doc, 'part_instance')).toEqual(['fp2'])
    expect(useAssemblyStore.getState().selectedPartHandle).toBeNull()
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('leaves a mate referencing the deleted part in place (no cascade; it goes stale at solve)', () => {
    const { host } = mountHost(sampleDoc())
    useAssemblyStore.getState().setSelectedPartHandle('h1')

    useAssemblyStore.getState().deleteSelected()

    // The mate survives with its now-dangling ref_a; the solver reports it stale.
    expect(ids(host.doc, 'mate')).toEqual(['fm1'])
    const survived = host.doc.features!.find(f => f.kind === 'mate')!.mate!
    expect(survived.ref_a.part).toBe('h1')
  })

  it('deletes the mate first when both a mate and a part are selected', () => {
    const { host } = mountHost(sampleDoc())
    useAssemblyStore.getState().setSelectedPartHandle('h1')
    useAssemblyStore.getState().setSelectedMateId('fm1')

    useAssemblyStore.getState().deleteSelected()

    expect(ids(host.doc, 'mate')).toEqual([])
    expect(ids(host.doc, 'part_instance')).toEqual(['fp1', 'fp2'])  // the part is untouched
  })

  it('is a no-op with nothing selected', () => {
    const { host, requestSolve } = mountHost(sampleDoc())

    useAssemblyStore.getState().deleteSelected()

    expect(host.doc).toEqual(sampleDoc())
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('routes a mate delete through setSelectedMateId, clearing a dangling armed field', () => {
    const { host, requestSolve } = mountHost(sampleDoc())
    useAssemblyStore.getState().setSelectedMateId('fm1')
    // A mate field is armed against the very mate now selected for deletion.
    useAssemblyStore.getState().setActiveMateField({ featureId: 'fm1', field: 'ref_a' })
    expect(useAssemblyStore.getState().activeMateField).not.toBeNull()

    useAssemblyStore.getState().deleteSelected()

    expect(ids(host.doc, 'mate')).toEqual([])
    // The delete must not bypass setSelectedMateId: the armed field that
    // pointed at the deleted mate would otherwise be left dangling.
    expect(useAssemblyStore.getState().selectedMateId).toBeNull()
    expect(useAssemblyStore.getState().activeMateField).toBeNull()
    expect(requestSolve).toHaveBeenCalled()
  })
})

// The editing subject is store-owned now, so its open/close/reconcile lifecycle
// is asserted here with no React in the picture.
describe('assemblyStore editingSubject', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.setState({ selectedPartHandle: null, selectedMateId: null, editingSubject: { kind: 'none' } })
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
    useAssemblyStore.getState().setSelectedPartHandle('h2')

    useAssemblyStore.getState().deleteSelected()

    // The edited h1 survived, so its editor stays open.
    expect(useAssemblyStore.getState().editingSubject).toEqual({ kind: 'instance', handle: 'h1' })
  })

  it('deleteSelected closes the editor on the deleted subject', () => {
    mountHost(sampleDoc())
    useAssemblyStore.getState().openMateEditor('fm1')
    useAssemblyStore.getState().setSelectedMateId('fm1')

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
