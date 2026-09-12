import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { waitFor } from '@testing-library/react'
import { useCarrierChangeStore } from '../carrierChangeStore'
import { useRecoveryStore } from '../recoveryStore'
import { useUnsavedChangesStore } from '../unsavedChangesStore'
import { getWorkspaceStore } from '@/workspace/store'
import { readWorkspaceMeta } from '@/workspace/idbCarrier'
import { DirectoryCarrier } from '@/workspace/directoryCarrier'
import { parseManifest, serializeManifest } from '@/workspace/manifest'
import { MANIFEST_PATH } from '@/workspace/paths'
import { forgetWorkspaceHandle } from '@/workspace/workspaceHandleRegistry'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'
import { fakeDirectory, type FakeDirectoryHandle } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The carrier-change state machine. A folder-bound workspace moves underneath
// the working copy; the check must catch it on open and on focus, and each of
// the three resolutions must land exactly as the C3 addendum states.

const text = (v: string) => `kind: part\n# ${v}\n`

function folderBinding(dir: FakeDirectoryHandle) {
  return { kind: 'folder' as const, label: dir.name, handle: dir as unknown as FileSystemDirectoryHandle }
}

// A folder-bound workspace whose working copy agrees with its carrier and is
// checked out as the checkpoint, so the only pending state is the foreign edit.
async function boundWorkspace() {
  const store = getWorkspaceStore()
  const dir = fakeDirectory('cad')
  const { workspace } = await store.create('Doc', { docKind: 'part', target: folderBinding(dir) })
  await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('saved') })
  await store.save(workspace, (await store.open(workspace)).tree)
  return { store, dir, workspace }
}

// A foreign edit that drops an entry from the manifest: the text is still a
// valid manifest, but its fingerprint no longer matches loadedFrom.
function foreignChange(dir: FakeDirectoryHandle, entryId: string) {
  const held = parseManifest(dir.snapshot()[MANIFEST_PATH])
  const changed = { ...held, entries: { ...held.entries } }
  delete changed.entries[entryId]
  dir.putText(MANIFEST_PATH, serializeManifest(changed))
}

beforeEach(() => {
  resetWorkspaceIdb()
  useCarrierChangeStore.getState().reset()
  useRecoveryStore.getState().reset()
  useUnsavedChangesStore.getState().setWorkspace(null)
  useUnsavedChangesStore.getState().setDirty(false)
})

afterEach(() => {
  useCarrierChangeStore.getState().reset()
  useRecoveryStore.getState().reset()
})

describe('carrierChangeStore', () => {
  it('detects a carrier change on open and arms the prompt', async () => {
    const { dir, workspace } = await boundWorkspace()
    foreignChange(dir, workspace)

    const asking = await useCarrierChangeStore.getState().begin(workspace)

    expect(asking).toBe(true)
    expect(useCarrierChangeStore.getState().status).toBe('changed')
    expect(useCarrierChangeStore.getState().workspace).toBe(workspace)
    expect(useCarrierChangeStore.getState().label).toBe('cad')
  })

  it('detects a carrier change on synthetic focus', async () => {
    const { dir, workspace } = await boundWorkspace()
    expect(await useCarrierChangeStore.getState().begin(workspace)).toBe(false)
    expect(useCarrierChangeStore.getState().status).toBe('idle')

    foreignChange(dir, workspace)
    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect(useCarrierChangeStore.getState().status).toBe('changed'), { timeout: 2000 })
  })

  it('reload replaces the working copy, checkpoints it, and clears divergence', async () => {
    const { store, dir, workspace } = await boundWorkspace()
    foreignChange(dir, workspace)
    await useCarrierChangeStore.getState().begin(workspace)

    await useCarrierChangeStore.getState().reload()

    expect(useCarrierChangeStore.getState().status).toBe('idle')
    expect(await store.listEntries(workspace)).toEqual([])
    expect((await store.open(workspace)).ahead).toBe(false)
    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.carrierDiverged).toBeFalsy()
    expect((await store.checkCarrier(workspace)).status).toBe('clean')
  })

  it('keep sets loadedFrom to the carrier hash and makes the divergence durable', async () => {
    const { store, dir, workspace } = await boundWorkspace()
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('dirty') })
    foreignChange(dir, workspace)
    await useCarrierChangeStore.getState().begin(workspace)

    await useCarrierChangeStore.getState().keep()

    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.carrierDiverged).toBe(true)
    // The prompt stops because loadedFrom now records the carrier's real state.
    expect((await store.checkCarrier(workspace)).status).toBe('clean')
    // The carrier is untouched: it still lacks the entry.
    expect((await new DirectoryCarrier(dir).open()).manifest.entries[workspace]).toBeUndefined()
    // The working copy stays ahead, so the next explicit save still overwrites.
    expect((await store.open(workspace)).ahead).toBe(true)
  })

  it('save over writes the carrier from the working copy and clears divergence', async () => {
    const { store, dir, workspace } = await boundWorkspace()
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('mine') })
    foreignChange(dir, workspace)
    await useCarrierChangeStore.getState().begin(workspace)

    await useCarrierChangeStore.getState().saveOver()

    const carrier = await new DirectoryCarrier(dir).open()
    expect(carrier.manifest.entries[workspace]).toBeDefined()
    expect(carrier.contents.get(workspace)?.text).toBe(text('mine'))
    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.carrierDiverged).toBe(false)
    expect((await store.open(workspace)).ahead).toBe(false)
  })

  it('treats an ungranted carrier as neutral, never a crash', async () => {
    const store = getWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Doc', { docKind: 'part', target: folderBinding(dir) })
    await forgetWorkspaceHandle(workspace)
    // Drop the resolved target so the check must go back to the registry.
    await store.close(workspace)

    const asking = await useCarrierChangeStore.getState().begin(workspace)

    expect(asking).toBe(false)
    expect(useCarrierChangeStore.getState().status).toBe('unavailable')
  })

  it('is a no-op for an IDB-only workspace', async () => {
    const store = getWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })

    const asking = await useCarrierChangeStore.getState().begin(workspace)

    expect(asking).toBe(false)
    expect(useCarrierChangeStore.getState().status).toBe('idle')
  })
})
