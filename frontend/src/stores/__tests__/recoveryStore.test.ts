import { describe, it, expect, beforeEach } from 'vitest'
import { useRecoveryStore } from '../recoveryStore'
import { useUnsavedChangesStore } from '../unsavedChangesStore'
import { IdbWorkspaceStore } from '@/workspace/store'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'

const text = (v: string) => `kind: part\n# ${v}\n`

async function makeDirtyWorkspace(store: IdbWorkspaceStore, version: string) {
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
})
