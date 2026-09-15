import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier, readWorkspaceMeta, writeWorkspaceMeta } from '../idbCarrier'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// IndexedDB is the permanent store and the only one, so an explicit save is the
// rows plus the checkpoint and nothing else can make it fail, hold it back or
// disagree with it afterwards.

describe('the save has one destination', () => {
  beforeEach(resetWorkspaceIdb)

  it('save writes the rows and checkpoints, leaving the workspace not ahead', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n',
    })
    expect((await store.open(workspace)).ahead).toBe(true)

    await store.save(workspace, (await store.open(workspace)).tree)

    const opened = await store.open(workspace)
    expect(opened.ahead).toBe(false)
    expect(opened.tree.contents.get(workspace)?.text).toBe('kind: part\n# v2\n')
    const idb = new IdbCarrier(workspace)
    expect(await idb.maxWorkingRev()).toBe(await idb.maxSavedRev())
  })

  it('saveEntry lands the entry and the checkpoint in one gesture', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.saveEntry(workspace, {
      id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# v2\n',
    })

    expect((await store.readEntry(workspace, workspace)).text).toBe('kind: part\n# v2\n')
    expect((await store.open(workspace)).ahead).toBe(false)
  })

  // `ahead` answers one question -- is the editor's copy newer than its save
  // point -- and it used to answer two, with a carrier disagreement OR'd into
  // it. Nothing can set it but a working-copy write.
  it('ahead follows the revisions alone', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.save(workspace, (await store.open(workspace)).tree)
    expect((await store.open(workspace)).ahead).toBe(false)

    await store.writeEntry(workspace, {
      id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: 'kind: part\n# edited\n',
    })
    expect((await store.open(workspace)).ahead).toBe(true)
  })

  // A row written while a folder or a zip could still be a residence keeps its
  // three residence fields. They are inert, not migrated, so the workspace must
  // open and save as if they were never there.
  it('opens a row that still carries the old residence fields', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    const meta = await readWorkspaceMeta(workspace)
    await writeWorkspaceMeta({
      ...meta!,
      ...{ carrier: { kind: 'folder', label: 'cad' }, loadedFrom: { carrier: 'folder', fingerprint: 'abc', at: 1 }, carrierDiverged: true },
    })

    const opened = await store.open(workspace)
    expect(opened.ahead).toBe(false)  // carrierDiverged is not an input any more
    await store.save(workspace, treeWith([documentEntry(workspace, 'Doc')], workspace))
    expect((await store.open(workspace)).ahead).toBe(false)
  })
})
