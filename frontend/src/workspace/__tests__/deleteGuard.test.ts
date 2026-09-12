import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { EntryReferencedError } from '../errors'
import { resetWorkspaceIdb } from './idbHarness'

const assemblyText = (partId: string): string =>
  `kind: assembly\nfeatures:\n  - kind: part_instance\n    instance:\n      handle: h1\n      doc_id: ${partId}\n      doc_rev: 1\n`

describe('entry delete guard', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
  })

  it('refuses to delete a part a live assembly references and names the referrer', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Part', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: assemblyText(workspace),
    })

    let thrown: unknown
    try {
      await store.removeEntry(workspace, workspace)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(EntryReferencedError)
    expect((thrown as EntryReferencedError).entry).toBe(workspace)
    expect((thrown as EntryReferencedError).referrers).toEqual([{ id: 'asm-1', name: 'Gearbox' }])
    // The refusal leaves the part live.
    expect((await store.listEntries(workspace)).map(entry => entry.id)).toContain(workspace)
  })

  it('soft-deletes an unreferenced part to the trash', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Part', { docKind: 'part' })

    await store.removeEntry(workspace, workspace)
    expect(await store.listEntries(workspace)).toEqual([])
    expect((await store.listEntries(workspace, { includeTrashed: true })).map(entry => entry.id)).toEqual([workspace])
  })

  it('lets a part go once its only referrer is already in the trash', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Part', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'asm-1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: assemblyText(workspace),
    })

    // Trash the referrer first, then the part is no longer live-referenced.
    await store.removeEntry(workspace, 'asm-1')
    await expect(store.removeEntry(workspace, workspace)).resolves.toBeUndefined()
  })
})
