import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useRecoveryStore } from '../recoveryStore'
import { useUnsavedChangesStore } from '../unsavedChangesStore'
import { IdbWorkspaceStore, getWorkspaceStore, type WorkspaceStore } from '@/workspace/store'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'

const text = (v: string) => `kind: part\n# ${v}\n`

async function makeDirtyWorkspace(store: WorkspaceStore, version: string) {
  const { workspace } = await store.create('Doc', { docKind: 'part' })
  await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text(version) })
  return workspace
}

describe('recoveryStore', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    useRecoveryStore.getState().reset()
    useUnsavedChangesStore.getState().setWorkspace(null)
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('does not arm the prompt for a clean workspace', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })

    expect(await useRecoveryStore.getState().begin(workspace)).toBe(false)
    expect(useRecoveryStore.getState().status).toBe('idle')
  })

  it('arms the prompt, with the last edit time, when the working copy is ahead', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await makeDirtyWorkspace(store, 'dirty')

    expect(await useRecoveryStore.getState().begin(workspace)).toBe(true)
    expect(useRecoveryStore.getState().status).toBe('asking')
    expect(useRecoveryStore.getState().workspace).toBe(workspace)
    expect(useRecoveryStore.getState().lastEditedAt).toBeGreaterThan(0)
  })

  it('keep adopts the working copy, clears ahead and clears dirty', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await makeDirtyWorkspace(store, 'dirty')
    await useRecoveryStore.getState().begin(workspace)
    useUnsavedChangesStore.getState().setDirty(true)

    await useRecoveryStore.getState().keep()

    expect((await store.open(workspace)).ahead).toBe(false)
    expect(await store.readEntry(workspace, workspace)).toMatchObject({ text: text('dirty') })
    expect(useRecoveryStore.getState().status).toBe('resolved')
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('discard resets the working copy to the checkpoint and clears dirty', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('saved') })
    await store.save(workspace, (await store.open(workspace)).tree)
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('dirty') })
    await useRecoveryStore.getState().begin(workspace)
    useUnsavedChangesStore.getState().setDirty(true)

    await useRecoveryStore.getState().discard()

    expect((await store.readEntry(workspace, workspace)).text).toBe(text('saved'))
    expect((await store.open(workspace)).ahead).toBe(false)
    expect(useRecoveryStore.getState().status).toBe('resolved')
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  // A store write that rejects used to leave `status` on 'asking' with nothing
  // rendered and no way out: the prompt hung forever.
  it('keeps the prompt up with a reason when a resolution fails', async () => {
    const store = getWorkspaceStore()
    const workspace = await makeDirtyWorkspace(store, 'dirty')
    await useRecoveryStore.getState().begin(workspace)
    useUnsavedChangesStore.getState().setDirty(true)
    const spy = vi.spyOn(store, 'checkpoint').mockRejectedValueOnce(new Error('quota exceeded'))

    await useRecoveryStore.getState().keep()

    expect(useRecoveryStore.getState().status).toBe('asking')
    expect(useRecoveryStore.getState().error).toContain('quota exceeded')
    expect(useRecoveryStore.getState().resolving).toBe(false)
    // Nothing was written, so the edits are still unsaved and still ahead.
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    expect((await store.open(workspace)).ahead).toBe(true)
    spy.mockRestore()

    // The same choice retried now lands.
    await useRecoveryStore.getState().keep()
    expect(useRecoveryStore.getState().status).toBe('resolved')
    expect(useRecoveryStore.getState().error).toBeUndefined()
  })

  it('refuses a second resolution while the first is in flight', async () => {
    const store = getWorkspaceStore()
    const workspace = await makeDirtyWorkspace(store, 'dirty')
    await useRecoveryStore.getState().begin(workspace)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const checkpoint = vi.spyOn(store, 'checkpoint').mockImplementation(() => gate)
    const discard = vi.spyOn(store, 'discard')

    const first = useRecoveryStore.getState().keep()
    expect(useRecoveryStore.getState().resolving).toBe(true)
    // A stale click on either choice, landing after the buttons went dead.
    const second = useRecoveryStore.getState().keep()
    const third = useRecoveryStore.getState().discard()
    release()
    await Promise.all([first, second, third])

    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(discard).not.toHaveBeenCalled()
    expect(useRecoveryStore.getState().status).toBe('resolved')
    checkpoint.mockRestore()
    discard.mockRestore()
  })

  it('dismiss leaves the working copy ahead, so the next open asks again', async () => {
    const store = getWorkspaceStore()
    const workspace = await makeDirtyWorkspace(store, 'dirty')
    await useRecoveryStore.getState().begin(workspace)

    useRecoveryStore.getState().dismiss()

    expect(useRecoveryStore.getState().status).toBe('resolved')
    expect((await store.open(workspace)).ahead).toBe(true)
    expect(await useRecoveryStore.getState().begin(workspace)).toBe(true)
  })
})
