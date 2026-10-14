import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { createDocSession } from '@/session/DocSession'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { assemblyHistory } from '@/stores/assemblyHistory'
import {
  useAssemblyStore,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
  setAssemblyCallbacks,
} from '@/stores/assemblyStore'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { AssemblyDoc, Mutation, PartDoc, SketchData } from '@/types/cad'
import type { AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'
import { editorState } from '@/stores/editorState'

// The part engine (the DocSession history) and the assembly engine
// (useAssemblyUndoRedo) expose different APIs over different document types,
// but they promise the same undo semantics. This file asserts that shared
// contract through a thin per-engine adapter, so a future change to one engine
// that breaks parity with the other fails here rather than shipping silently.
type AnyDoc = PartDoc | AssemblyDoc

interface UndoContractHarness {
  setLive: (doc: AnyDoc | null) => void
  // Records one step whose restored doc is `doc`; the live doc is untouched.
  push: (doc: AnyDoc) => void
  undo: () => void
  redo: () => void
  // The tracked feature id of each entry, oldest first, so retention and
  // identity are observable through both engines' differently shaped entries.
  undoIds: () => string[]
  redoIds: () => string[]
  live: () => AnyDoc | null
  // Rewrites the tracked feature id in place, standing in for any path that
  // mutates the live doc without going through a push.
  corruptFeatureId: (doc: AnyDoc) => void
}

const makePartDoc = (id: string): PartDoc =>
  ({ version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] }) as PartDoc

const makeAssemblyDoc = (id: string): AssemblyDoc => ({
  kind: 'assembly',
  features: [{
    id,
    kind: 'part_instance',
    instance: {
      handle: id, doc_id: `d-${id}`, doc_rev: 1,
      transform: { ...IDENTITY_TRANSFORM }, visible: true,
    },
  }],
})

function partEntryId(doc: PartDoc): string {
  return doc.features?.[0]?.id ?? ''
}

function assemblyEntryId(doc: AssemblyDoc): string {
  return doc.features?.[0]?.instance?.handle ?? ''
}

// The assembly stacks live in the module-level History, so each case starts by
// clearing it (setSnapshot deliberately preserves the store-owned mirror).
function resetAssemblyStore() {
  useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  useAssemblyStore.getState().clearAssemblyHistory()
  useAssemblyStore.setState({
    subject: null, activeMateField: null, mateFieldDirty: false,
    pickCandidates: [], pickIndex: -1,
    editingSubject: { kind: 'none' },
  })
  useUnsavedChangesStore.getState().setDirty(false)
  setAssemblyCallbacks(null)
}

function createPartHarness(): UndoContractHarness {
  usePartEditorStore.setState(DEFAULT_PART_EDITOR_DATA)
  editorState.getState().resetEditorState()
  useUnsavedChangesStore.getState().setDirty(false)

  const cell: { current: PartDoc | null } = { current: null }
  const solve = createFakeSolveScheduler<PartDoc>()
  const facts = { editingFeatureId: null as string | null, rollbackPosition: null as number | null }
  const dirty = { dirty: false, saves: 0, savedHash: null as number | null }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: cloneDocForUndo,
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => facts,
    dirtyFacts: () => dirty,
  })

  return {
    setLive: (doc) => { cell.current = doc as PartDoc | null },
    push: (doc) => { session.pushUndo('push', doc as PartDoc, { type: 'add_sketch' } as Mutation) },
    undo: () => { session.undo() },
    redo: () => { session.redo() },
    undoIds: () => session.historyEntries().undo.map(e => partEntryId(e.doc)),
    redoIds: () => session.historyEntries().redo.map(e => partEntryId(e.doc)),
    live: () => cell.current,
    corruptFeatureId: (doc) => {
      const feature = (doc as PartDoc).features?.[0]
      if (feature) feature.id = 'corrupted'
    },
  }
}

function createAssemblyHarness(): UndoContractHarness {
  resetAssemblyStore()

  const docRef: { current: AssemblyDoc | null } = { current: null }
  const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc | null })
  const view = renderHookStrict(() => useAssemblyUndoRedo(
    docRef as React.MutableRefObject<AssemblyDoc | null>, setDoc, vi.fn(),
  ))

  return {
    setLive: (doc) => { docRef.current = doc as AssemblyDoc | null },
    push: (doc) => {
      const label = assemblyEntryId(doc as AssemblyDoc) as AssemblyUndoLabel
      act(() => view.result.current.pushUndo(doc as AssemblyDoc, label))
    },
    undo: () => { act(() => view.result.current.handleUndo()) },
    redo: () => { act(() => view.result.current.handleRedo()) },
    // Reads go through the same History object the hook writes: the store
    // fields the UI reads are only its mirror, so a parallel stack would be
    // invisible here. The pushes above still drive the engine's public hook.
    undoIds: () => assemblyHistory.undoEntries().map(e => assemblyEntryId(e.doc)),
    redoIds: () => assemblyHistory.redoEntries().map(e => assemblyEntryId(e.doc)),
    live: () => docRef.current,
    corruptFeatureId: (doc) => {
      const instance = (doc as AssemblyDoc).features?.[0]?.instance
      if (instance) instance.handle = 'corrupted'
    },
  }
}

const engines = [
  { name: 'DocSession history (part)', makeDoc: makePartDoc, createHarness: createPartHarness },
  { name: 'useAssemblyUndoRedo (assembly)', makeDoc: makeAssemblyDoc, createHarness: createAssemblyHarness },
]

describe.each(engines)('undo engine contract: $name', ({ makeDoc, createHarness }) => {
  it('a fresh push clears the redo branch', () => {
    const h = createHarness()
    h.setLive(makeDoc('a'))
    h.push(makeDoc('a'))
    h.undo()
    expect(h.redoIds()).toHaveLength(1)

    h.push(makeDoc('b'))

    expect(h.redoIds()).toHaveLength(0)
    expect(h.undoIds()).toHaveLength(1)
  })

  it('undo then redo round-trips the document value back to the post-edit state', () => {
    const h = createHarness()
    const pre = makeDoc('pre')
    const post = makeDoc('post')
    h.setLive(post)
    h.push(pre)

    h.undo()
    expect(h.live()).toEqual(pre)

    h.redo()
    expect(h.live()).toEqual(post)
  })

  it('entries hold snapshots, not references, so mutating the source cannot rewrite history', () => {
    const h = createHarness()
    h.setLive(makeDoc('live'))
    const source = makeDoc('source')
    h.push(source)

    h.corruptFeatureId(source)

    expect(h.undoIds()).toEqual(['source'])
  })

  it('the cap drops the oldest entries and keeps the newest', () => {
    const h = createHarness()
    const pushes = MAX_UNDO_DEPTH + 3
    for (let i = 0; i < pushes; i++) h.push(makeDoc(`f${i}`))

    const ids = h.undoIds()

    expect(ids).toHaveLength(MAX_UNDO_DEPTH)
    expect(ids[0]).toBe(`f${pushes - MAX_UNDO_DEPTH}`)
    expect(ids[ids.length - 1]).toBe(`f${pushes - 1}`)
  })

  it('a move shifts exactly one entry, so undo plus redo stays constant', () => {
    const h = createHarness()
    h.setLive(makeDoc('live'))
    for (let i = 0; i < 5; i++) h.push(makeDoc(`f${i}`))

    const total = h.undoIds().length + h.redoIds().length
    expect(total).toBe(5)

    for (let i = 0; i < 3; i++) {
      h.undo()
      h.redo()
      expect(h.undoIds().length + h.redoIds().length).toBe(total)
    }
  })

  it('with no live document, undo and redo are no-ops that leave the stacks paired', () => {
    const h = createHarness()
    h.setLive(makeDoc('live'))
    h.push(makeDoc('a'))

    h.setLive(null)
    h.undo()
    expect(h.undoIds()).toEqual(['a'])
    expect(h.redoIds()).toEqual([])

    h.setLive(makeDoc('post'))
    h.undo()
    expect(h.redoIds()).toHaveLength(1)

    h.setLive(null)
    h.redo()
    expect(h.undoIds()).toHaveLength(0)
    expect(h.redoIds()).toHaveLength(1)
  })
})
