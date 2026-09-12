import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useUnsavedChangesStore, confirmDiscardUnsavedChanges } from '@/stores/unsavedChangesStore'
import { IdbWorkspaceStore } from '@/workspace/store'
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
})
