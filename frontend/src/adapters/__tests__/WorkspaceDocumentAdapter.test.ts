import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { resetPreviewDbConnection } from '@/stores/previewStore'
import { IdbWorkspaceStore } from '@/workspace/store'
import { WorkspaceDocumentAdapter } from '../library'

// The live browser-library path: the adapter over WorkspaceStore is what the
// grid, the editors and the trash actually call, so the content-equality guard
// and the kind round-trip are pinned here rather than on the ancestor
// IndexedDbDocumentStore, which the app no longer wires in.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
  resetPreviewDbConnection()
})

function adapter(): WorkspaceDocumentAdapter {
  return new WorkspaceDocumentAdapter(new IdbWorkspaceStore())
}

describe('WorkspaceDocumentAdapter', () => {
  it('a no-op save does not bump rev, a content change does', async () => {
    const store = adapter()
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: 'kind: part\n# v1\n' })

    const first = (await store.list()).find(d => d.uuid === uuid)!
    await store.save(uuid, { content: 'kind: part\n# v1\n' })
    const unchanged = (await store.list()).find(d => d.uuid === uuid)!
    expect(unchanged.meta?.rev).toBe(first.meta?.rev)

    await store.save(uuid, { content: 'kind: part\n# v2\n' })
    const changed = (await store.list()).find(d => d.uuid === uuid)!
    expect(changed.meta!.rev).toBeGreaterThan(first.meta!.rev)
  })

  it('preserves an unknown docKind on save and load rather than coercing it (I9)', async () => {
    const store = adapter()
    const { uuid } = await store.create('Draft')
    // `create` seeds docKind 'part'; the body names an unknown kind and the
    // adapter must adopt that open value instead of falling back to part.
    await store.save(uuid, { content: 'kind: drawing\n# keep\n' })

    const loaded = await store.load(uuid)
    expect(loaded.kind).toBe('drawing')
    expect(loaded.content).toBe('kind: drawing\n# keep\n')

    // A later save that does not name a kind keeps the unknown one.
    await store.save(uuid, { content: 'kind: drawing\n# edited\n' })
    expect((await store.load(uuid)).kind).toBe('drawing')
  })
})
