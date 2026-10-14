import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUnsavedChangesStore, confirmDiscardUnsavedChanges, hashSavedText } from '@/stores/unsavedChangesStore'
import { IdbWorkspaceStore, getWorkspaceStore, type OpenWorkspace } from '@/workspace/store'
import { createTree, emptyManifest } from '@/workspace'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'

describe('confirmDiscardUnsavedChanges', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().dismissConfirm()
    useUnsavedChangesStore.getState().setWorkspace(null)
  })

  it('proceeds without prompting when there are no unsaved changes', () => {
    expect(confirmDiscardUnsavedChanges()).toBe(true)
    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
  })

  it('returns false and stores a callback when the document is dirty', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    expect(confirmDiscardUnsavedChanges()).toBe(false)
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('executing the pending callback clears dirty and fires onProceed', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    let proceeded = false
    expect(confirmDiscardUnsavedChanges(() => { proceeded = true })).toBe(false)
    const cb = useUnsavedChangesStore.getState().pendingCallback
    expect(cb).not.toBeNull()
    cb!()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(proceeded).toBe(true)
  })

  it('dismissConfirm clears the pending callback', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    confirmDiscardUnsavedChanges()
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    useUnsavedChangesStore.getState().dismissConfirm()
    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
  })

  // Nav target A clicked, then B while the dialog is up: overwriting A's
  // proceed would silently drop A's navigation when the user discards.
  // First-requested navigation wins.
  it('a second request keeps the existing callback instead of overwriting it', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    const fnA = vi.fn()
    const fnB = vi.fn()
    expect(confirmDiscardUnsavedChanges(fnA)).toBe(false)
    expect(confirmDiscardUnsavedChanges(fnB)).toBe(false)

    const cb = useUnsavedChangesStore.getState().pendingCallback
    cb!()
    expect(fnA).toHaveBeenCalledTimes(1)
    expect(fnB).not.toHaveBeenCalled()
  })
})

// The fingerprint a save publishes of the exact bytes it wrote. A cancel that
// rewinds a doc saved mid-session has to compare against what is really in the
// store: the save count alone cannot tell a session that changed the stored
// bytes from one that did not.
describe('the fingerprint of the bytes a save stored', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('is stable for the same text and moves when the text moves', () => {
    expect(hashSavedText('kind: part')).toBe(hashSavedText('kind: part'))
    expect(hashSavedText('kind: part')).not.toBe(hashSavedText('kind: assembly'))
  })

  it('records what the save stored, alongside the save count', () => {
    useUnsavedChangesStore.getState().markSaved(hashSavedText('kind: part'))

    expect(useUnsavedChangesStore.getState().saves).toBe(1)
    expect(useUnsavedChangesStore.getState().savedHash).toBe(hashSavedText('kind: part'))
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  // A save that publishes nothing must not leave the previous save's
  // fingerprint behind for a later cancel to trust as current.
  it('a save that publishes no fingerprint clears the stored one', () => {
    useUnsavedChangesStore.getState().markSaved(hashSavedText('kind: part'))
    useUnsavedChangesStore.getState().markSaved()

    expect(useUnsavedChangesStore.getState().savedHash).toBeNull()
  })

  // A new document inherits none of it: a session pinned in B must not read
  // A's save count as one of its own, and a cancel must not compare its rewind
  // against the text A stored.
  it('opening a document drops the flag, the count and the fingerprint together', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    useUnsavedChangesStore.getState().markSaved(hashSavedText('kind: part'))
    useUnsavedChangesStore.getState().setDirty(true)

    useUnsavedChangesStore.getState().clearForNewDocument()

    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(useUnsavedChangesStore.getState().saves).toBe(0)
    expect(useUnsavedChangesStore.getState().savedHash).toBeNull()
  })
})

// U7: dirty is derived from the workspace's working copy versus its checkpoint,
// and the seam's revision emitter drives the refresh.
describe('workspace-scoped dirty', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    useUnsavedChangesStore.getState().setWorkspace(null)
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('mirrors ahead through setWorkspace and the store emitter', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })

    useUnsavedChangesStore.getState().setWorkspace(workspace)
    await vi.waitFor(() => expect(useUnsavedChangesStore.getState().dirty).toBe(false))

    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# edit\n' })
    await vi.waitFor(() => expect(useUnsavedChangesStore.getState().dirty).toBe(true))

    await store.save(workspace, (await store.open(workspace)).tree)
    await vi.waitFor(() => expect(useUnsavedChangesStore.getState().dirty).toBe(false))

    useUnsavedChangesStore.getState().setWorkspace(null)
  })

  // A save fires two refreshes and the one that started first can resolve last.
  // The token guard is what stops the stale one from writing its `ahead` back
  // over the newer answer.
  it('a stale refresh cannot overwrite a newer one with its ahead', async () => {
    const store = getWorkspaceStore()
    const pending: Array<(value: OpenWorkspace) => void> = []
    const spy = vi.spyOn(store, 'open').mockImplementation(
      () => new Promise<OpenWorkspace>(resolve => { pending.push(resolve) }),
    )
    const result = (ahead: boolean): OpenWorkspace => ({
      tree: createTree(emptyManifest('race-ws')), workingRev: 0, savedRev: 0, ahead, lastEditedAt: 0,
    })
    try {
      useUnsavedChangesStore.getState().setWorkspace('race-ws')
      void useUnsavedChangesStore.getState().refreshWorkspaceDirty()
      expect(pending).toHaveLength(2)

      // The later refresh lands first and says clean.
      pending[1](result(false))
      await Promise.resolve()
      expect(useUnsavedChangesStore.getState().dirty).toBe(false)

      // The earlier refresh lands after it and says dirty; it must be ignored.
      pending[0](result(true))
      await Promise.resolve()
      expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    } finally {
      spy.mockRestore()
      useUnsavedChangesStore.getState().setWorkspace(null)
    }
  })
})
