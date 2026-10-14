import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUnsavedChangesStore, confirmDiscardUnsavedChanges, hashSavedText, reconcileDirtyAfterRewind } from '@/stores/unsavedChangesStore'
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
    // The count and the fingerprint are module-level, so a leaked one would let
    // one test read another test's save.
    useUnsavedChangesStore.getState().clearForNewDocument()
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

  // An edit that landed during the write postdates the stored bytes, so the
  // save publishes the fingerprint but leaves the flag set.
  it('keeps the flag when the save reports an edit landed during it, while still recording the bytes', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    useUnsavedChangesStore.getState().markSaved(hashSavedText('kind: part'), false)

    expect(useUnsavedChangesStore.getState().saves).toBe(1)
    expect(useUnsavedChangesStore.getState().savedHash).toBe(hashSavedText('kind: part'))
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
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

// The shared decision every cancel and commit uses to re-derive the flag from
// the bytes a mid-session save actually stored, so the three call sites cannot
// drift apart.
describe('reconcileDirtyAfterRewind', () => {
  beforeEach(() => {
    useUnsavedChangesStore.getState().clearForNewDocument()
  })

  const dirty = () => useUnsavedChangesStore.getState().dirty

  it('compares the restored text against the published fingerprint when a save landed', () => {
    useUnsavedChangesStore.getState().markSaved(hashSavedText('A'))
    const pinned = { dirty: true, saves: 0 }

    reconcileDirtyAfterRewind(pinned, false, () => 'A')
    expect(dirty()).toBe(false)

    reconcileDirtyAfterRewind(pinned, true, () => 'B')
    expect(dirty()).toBe(true)
  })

  it('falls back to the pinned flag when the save published no fingerprint', () => {
    useUnsavedChangesStore.getState().markSaved()  // saves 1, no fingerprint
    // A dirty pin makes the two branches distinguishable: the rewind-changed
    // case restores it (and a moved save count forces dirty anyway), while the
    // rewind-changed-nothing case must leave the flag where the save left it.
    const pinned = { dirty: true, saves: 0 }

    reconcileDirtyAfterRewind(pinned, false, () => 'A')
    expect(dirty()).toBe(false)

    // The rewind changed content, so the stored bytes are not the ones restored.
    reconcileDirtyAfterRewind(pinned, true, () => 'A')
    expect(dirty()).toBe(true)
  })

  it('restores the pinned flag when no save landed, whatever the rewind did', () => {
    useUnsavedChangesStore.getState().setDirty(true)
    const pinned = { dirty: false, saves: 0 }

    reconcileDirtyAfterRewind(pinned, false, () => 'A')
    expect(dirty()).toBe(false)

    useUnsavedChangesStore.getState().setDirty(true)
    reconcileDirtyAfterRewind(pinned, true, () => 'A')
    expect(dirty()).toBe(false)
  })

  // The thunk is only paid when a save landed: a no-save reconcile must not
  // serialize the restored doc.
  it('does not serialize the restored doc when no save landed', () => {
    const serialize = vi.fn(() => 'A')
    reconcileDirtyAfterRewind({ dirty: false, saves: 0 }, true, serialize)
    expect(serialize).not.toHaveBeenCalled()
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
