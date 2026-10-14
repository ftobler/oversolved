import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { stringify as stringifyYaml } from 'yaml'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'

import { useUnsavedChangesStore, hashSavedText } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'
import { docRef, renameTo, resetHarness } from './usePartDoc.undoHarness'
import { useEditorState } from '@/hooks/useEditorState'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

const dirty = () => useUnsavedChangesStore.getState().dirty

// What useDocPersistence.saveDoc publishes once the bytes land: the fingerprint
// of the exact text it serialized and stored. A suppressed session edits the
// live doc in place, so the text a mid-session save stores is the live doc's
// text at that moment -- which is what the cancel below has to compare against.
const saveTheLiveDoc = () => {
  useUnsavedChangesStore.getState().markSaved(hashSavedText(stringifyYaml(docRef.current!)))
}

const expressionOf = () => (docRef.current!.features?.[0] as { variable?: { expression?: string } }).variable?.expression

const setExpression = (value: string): Mutation =>
  ({ type: 'set_variable_field', featureId: 'v1', field: 'expression', value }) as Mutation

// Stands in for the solver write-back (applySolveResult in useSolver): every
// solve installs a fresh doc object with the solved geometry re-baked into the
// features, so a live doc can differ from the session snapshot with no user edit
// in between. Without this the suite could not reach the cancelled state where
// the rewind matters.
const landWriteBack = (result: { current: { setDoc: (d: PartDoc) => void } }) => {
  const doc = docRef.current!
  result.current.setDoc({
    ...doc,
    features: (doc.features ?? []).map(f => ({ ...f, initial: { l1: [0, 0, 3.141593, 0] } })),
  } as PartDoc)
}

// A cancel rewinds the doc to the moment its session or preview opened, so the
// unsaved-changes flag goes back with it; the assembly cancelSession already
// did this, the part editor left the flag set.
describe('usePartDoc cancel restores the unsaved-changes flag', () => {
  beforeEach(() => {
    resetHarness()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('cancelling an edit session on a clean doc leaves it clean', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(false)
  })

  it('cancelling an edit session opened on a dirty doc keeps it dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('kept')) })
    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('discarded')) })

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(true)
  })

  // The save stored the session's edits; the rewind throws them away, so the
  // live doc no longer matches what is saved even though it was clean at entry.
  it('a save mid-session leaves the cancelled doc dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('saved-then-discarded')) })
    useUnsavedChangesStore.getState().markSaved()  // the save landing

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(true)
  })

  // The flag alone cannot tell this from "never saved": the edit after the save
  // set it again, so only the save count says the stored bytes hold the edits.
  it('a save followed by another edit mid-session still leaves the cancelled doc dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation(renameTo('saved')) })
    useUnsavedChangesStore.getState().markSaved()
    act(() => { result.current.handleMutation(renameTo('edited-after-save')) })
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(true)
  })

  // Open the editor, Ctrl+S, Escape. The session changed nothing, so the rewind
  // put back the very doc the save just stored: there is no unsaved edit left,
  // and honouring the pinned save count anyway would flag the document dirty
  // forever with nothing to save.
  it('a save during a session that changed nothing leaves the document clean', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    useUnsavedChangesStore.getState().markSaved()  // the save landing

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(false)
  })

  // The write-back installs a fresh doc object whenever a solve bakes anything,
  // so the cancel cannot decide "nothing changed" by object identity: here the
  // object moved and the content did not.
  it('a session whose doc was replaced without changing content leaves the flag alone', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    useEditorState.getState().setEditingFeatureId('extrude-1')
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.setDoc(structuredClone(docRef.current)) })
    useUnsavedChangesStore.getState().markSaved()  // the save landing

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(false)
  })

  it('cancelling a color preview on a clean doc leaves it clean', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelPreview() })
    expect(dirty()).toBe(false)
  })

  // A save during an open preview that changed nothing stored the very text the
  // cancel restores, so nothing is unsaved. The count-based restore flagged the
  // document dirty forever because the save count moved even though the preview
  // threw nothing away.
  it('a save during an open preview that changed nothing leaves the document clean', () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [],
    } as unknown as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    saveTheLiveDoc()  // the save stores the baseline: no edit landed in between

    act(() => { result.current.cancelPreview() })
    expect(dirty()).toBe(false)
  })

  // The five cases the cancel decides by comparing the doc it restores against
  // the bytes the last save actually stored. A save during a session is the
  // whole difficulty: the session's doc-under-edit IS the live doc, so the stored
  // text can be the text the rewind restores (nothing unsaved) or the text of an
  // edit it throws away (unsaved), and only the stored fingerprint tells the two
  // apart.
  const openSessionOnVariable = (result: { current: ReturnType<typeof usePartDoc> }) => {
    useEditorState.getState().setEditingFeatureId('v1')
    act(() => { result.current.startEditSession(true) })
  }

  const renderVariableDoc = () => {
    docRef.current = {
      version: 1,
      kind: 'part',
      features: [{ id: 'v1', kind: 'variable', label: 'v1', variable: { expression: '10' } }],
    } as unknown as PartDoc
    return renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
  }

  // (a) Open the editor, Ctrl+S, Escape. The rewind restores the very text the
  // save stored, so nothing is unsaved.
  it('(a) a save during a session that edited nothing leaves the cancelled document clean', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)
    saveTheLiveDoc()

    act(() => { result.current.cancelEditSession() })

    expect(dirty()).toBe(false)
    expect(expressionOf()).toBe('10')
  })

  // (b) The value went 10 -> 20 -> 10, so the session's work netted to zero and
  // the save stored a doc byte-identical to the snapshot. The solve that the last
  // edit kicked off then wrote back a re-baked `initial`, so the live doc differs
  // from the snapshot: the save count moved and the doc compare says the rewind
  // threw something away, but the restored text IS the stored text.
  it('(b) a save during a net-zero session leaves the cancelled document clean', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)
    act(() => { result.current.handleMutation(setExpression('20')) })
    act(() => { result.current.handleMutation(setExpression('10')) })
    expect(expressionOf()).toBe('10')
    saveTheLiveDoc()
    landWriteBack(result)

    act(() => { result.current.cancelEditSession() })

    expect(dirty()).toBe(false)
    expect(expressionOf()).toBe('10')
  })

  // (f) The value went 10 -> 20 -> 10 with no save in between, so the stored
  // bytes are still the ones the rewind restores. Every one of the session's
  // mutations set the flag, and netting them out has to clear it again: the
  // document on disk is exactly the document that becomes live.
  it('(f) a net-zero session with no save leaves the cancelled document clean', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)
    act(() => { result.current.handleMutation(setExpression('20')) })
    act(() => { result.current.handleMutation(setExpression('10')) })
    expect(expressionOf()).toBe('10')
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelEditSession() })

    expect(dirty()).toBe(false)
    expect(expressionOf()).toBe('10')
  })

  // (c) The save stored the edit (value 20); the rewind throws that text away, so
  // the live doc no longer matches the stored bytes and must stay flagged.
  it('(c) a save during an edited session leaves the cancelled document dirty', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)
    act(() => { result.current.handleMutation(setExpression('20')) })
    saveTheLiveDoc()

    act(() => { result.current.cancelEditSession() })

    expect(dirty()).toBe(true)
    expect(expressionOf()).toBe('10')
  })

  // (d) No save landed, so the flag the session found is the flag it leaves. The
  // session's mutations each set the flag, and the rewind restores the doc that
  // flag described: an edit made and cancelled inside a clean document leaves
  // nothing to save, exactly as cancelling any other clean-doc session does.
  it('(d) an edited session with no save leaves the cancelled document clean', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)
    act(() => { result.current.handleMutation(setExpression('20')) })
    expect(dirty()).toBe(true)

    act(() => { result.current.cancelEditSession() })
    expect(dirty()).toBe(false)
  })

  // (e) Nothing was edited and nothing was saved, on a document that was already
  // clean: there is no unsaved edit to warn about.
  it('(e) a session that edited nothing on a clean document leaves it clean', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)

    act(() => { result.current.cancelEditSession() })

    expect(dirty()).toBe(false)
  })

  // Committing a suppressed session that netted to zero pushes no entry, but
  // every one of its mutations set the dirty flag on the way through. The
  // committed doc equals the session baseline, so the flag has to come back
  // down, or the document would warn about edits that are not there.
  it('(g) committing a net-zero session leaves the document clean', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)
    act(() => { result.current.handleMutation(setExpression('20')) })
    act(() => { result.current.handleMutation(setExpression('10')) })
    expect(expressionOf()).toBe('10')
    expect(dirty()).toBe(true)

    act(() => { result.current.commitEditSession() })

    expect(dirty()).toBe(false)
    expect(expressionOf()).toBe('10')
  })

  // The control: a session with a real change pushes its aggregate entry, and
  // the dirty flag is exactly what that entry represents, so it stays set.
  it('(h) committing a real change leaves the document dirty', () => {
    const { result } = renderVariableDoc()
    openSessionOnVariable(result)
    act(() => { result.current.handleMutation(setExpression('42')) })

    act(() => { result.current.commitEditSession() })

    expect(dirty()).toBe(true)
    expect(expressionOf()).toBe('42')
  })

  // A sketch session is not suppressed: each action pushes its own entry and the
  // commit pushes no aggregate. sessionWouldPush is false for it, but that is not
  // "netted to zero": the committed edits ARE the per-action entries, and the
  // dirty flag is exactly what those still-unsaved edits represent. Reconciling
  // here against the session baseline would clear a flag the edits earned and
  // silently drop the unsaved-changes warning.
  it('(i) committing a sketch session keeps the document dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startEditSession(false) })  // sketch: not suppressed
    act(() => { result.current.handleMutation(renameTo('edited')) })
    expect(dirty()).toBe(true)

    act(() => { result.current.commitEditSession() })

    // The action's own entry is the edit's undo story, so the commit leaves both
    // the stack and the dirty flag alone.
    expect(result.current.undoStack).toHaveLength(1)
    expect(dirty()).toBe(true)
  })
})

// The dirty mirror writes exactly the decision a session call made, once. The
// old funnel left the store untouched on a no-op dispatch, and the workspace
// seam (refreshWorkspaceDirty) can move the live flag between calls, so a
// no-op must never re-assert the session's last decision over that newer set.
describe('usePartDoc dirty mirror does not clobber external sets', () => {
  beforeEach(() => {
    resetHarness()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('an external clear survives a no-op mutation dispatch', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    expect(dirty()).toBe(true)

    // The workspace seam clears the flag; the session's last decision is stale.
    useUnsavedChangesStore.getState().setDirty(false)

    // A same-value dispatch is a no-op and must leave the store alone.
    act(() => { result.current.handleMutation(renameTo('a')) })
    expect(dirty()).toBe(false)
  })

  it('an external clear survives a no-op group dispatch', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.commitMutationGroup([renameTo('a')]) })
    expect(dirty()).toBe(false)
  })

  it('an external set survives a no-op dispatch', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    // The seam flags the workspace ahead with no edit of our own.
    useUnsavedChangesStore.getState().setDirty(true)

    act(() => { result.current.handleMutation(renameTo('first')) })
    expect(dirty()).toBe(true)
  })

  it('a real edit after an external clear still mirrors dirty', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    useUnsavedChangesStore.getState().setDirty(false)

    act(() => { result.current.handleMutation(renameTo('b')) })
    expect(dirty()).toBe(true)
  })
})
