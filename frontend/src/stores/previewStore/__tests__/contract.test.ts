import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { PreviewStore } from '../types'
import { previewKey } from '../types'
import { MemoryPreviewStore } from '../memoryPreviewStore'
import { IndexedDbPreviewStore, resetPreviewDbConnection } from '../IndexedDbPreviewStore'

// The preview store's behavioural contract, over the in-memory conformer and the
// IndexedDB one, so the two cannot drift on the key or the base64 passthrough.
interface Adapter {
  name: string
  setup: () => void
  make: () => PreviewStore
}

const adapters: Adapter[] = [
  {
    name: 'MemoryPreviewStore',
    setup: () => {},
    make: () => new MemoryPreviewStore(),
  },
  {
    name: 'IndexedDbPreviewStore',
    setup: () => {
      globalThis.indexedDB = new IDBFactory()
      resetPreviewDbConnection()
    },
    make: () => new IndexedDbPreviewStore(),
  },
]

describe.each(adapters)('PreviewStore contract: $name', (adapter) => {
  let store: PreviewStore

  beforeEach(() => {
    adapter.setup()
    store = adapter.make()
  })

  it('put then get round-trips base64 without transformation', async () => {
    const image = btoa('\x89PNG\r\n\x1a\n')
    await store.put('ws-1', 'e1', image)
    expect(await store.get('ws-1', 'e1')).toBe(image)
  })

  it('keys are scoped by workspace and entry', async () => {
    await store.put('ws-1', 'e1', 'one')
    await store.put('ws-1', 'e2', 'two')
    expect(await store.get('ws-1', 'e1')).toBe('one')
    expect(await store.get('ws-1', 'e2')).toBe('two')
    expect(await store.get('ws-2', 'e1')).toBeUndefined()
  })

  it('put overwrites an existing key', async () => {
    await store.put('ws-1', 'e1', 'old')
    await store.put('ws-1', 'e1', 'new')
    expect(await store.get('ws-1', 'e1')).toBe('new')
  })

  it('getMany batches the requested keys and omits misses', async () => {
    await store.put('ws-1', 'e1', 'one')
    await store.put('ws-1', 'e2', 'two')
    const many = await store.getMany([
      { workspace: 'ws-1', entry: 'e1' },
      { workspace: 'ws-1', entry: 'e2' },
      { workspace: 'ws-1', entry: 'missing' },
    ])
    expect(many.get(previewKey('ws-1', 'e1'))).toBe('one')
    expect(many.get(previewKey('ws-1', 'e2'))).toBe('two')
    expect(many.size).toBe(2)
  })

  it('remove drops one key', async () => {
    await store.put('ws-1', 'e1', 'one')
    await store.remove('ws-1', 'e1')
    expect(await store.get('ws-1', 'e1')).toBeUndefined()
  })

  it('clearWorkspace drops only that workspace', async () => {
    await store.put('ws-1', 'e1', 'one')
    await store.put('ws-1', 'e2', 'two')
    await store.put('ws-2', 'e1', 'other')
    await store.clearWorkspace('ws-1')
    expect(await store.get('ws-1', 'e1')).toBeUndefined()
    expect(await store.get('ws-1', 'e2')).toBeUndefined()
    expect(await store.get('ws-2', 'e1')).toBe('other')
  })
})
