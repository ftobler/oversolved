/**
 * The IndexedDbPreviewStore's failure surfaces: a preview write that fails must
 * reject rather than resolve as if it landed, and an aborted clear must leave
 * the rows it did not finish deleting in place. The happy-path contract lives
 * in the sibling contract.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDbPreviewStore, resetPreviewDbConnection } from '../IndexedDbPreviewStore'

let store: IndexedDbPreviewStore

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetPreviewDbConnection()
  store = new IndexedDbPreviewStore()
})

describe('IndexedDbPreviewStore failure surfaces', () => {
  it('rejects a put whose request fails and keeps the previous preview', async () => {
    await store.put('ws-1', 'e1', 'old')

    // `add` on the same compound key is a real ConstraintError request, so the
    // failure comes from the request rather than a synchronous keyPath check.
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: unknown[]) {
      return (this.add as unknown as (...a: unknown[]) => IDBRequest).apply(this, args)
    } as typeof IDBObjectStore.prototype.put
    try {
      await expect(store.put('ws-1', 'e1', 'new')).rejects.toMatchObject({ name: 'ConstraintError' })
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }

    expect(await store.get('ws-1', 'e1')).toBe('old')
  })

  it('rejects a clear whose delete aborts the transaction and rolls it back', async () => {
    await store.put('ws-1', 'e1', 'one')
    await store.put('ws-1', 'e2', 'two')
    await store.put('ws-2', 'e1', 'other')

    // Throwing from inside the getAll success callback aborts the transaction;
    // the deletes already queued for ws-1 must not land.
    const originalDelete = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = function (): IDBRequest {
      throw new Error('delete failed')
    } as typeof IDBObjectStore.prototype.delete
    try {
      await expect(store.clearWorkspace('ws-1')).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      IDBObjectStore.prototype.delete = originalDelete
    }

    expect(await store.get('ws-1', 'e1')).toBe('one')
    expect(await store.get('ws-1', 'e2')).toBe('two')
    expect(await store.get('ws-2', 'e1')).toBe('other')
  })

  it('rejects when the database open request errors', async () => {
    const error = new DOMException('open failed', 'UnknownError')
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB)
    globalThis.indexedDB.open = (() => {
      const req = { result: undefined, error, onsuccess: null, onupgradeneeded: null, onerror: null } as unknown as IDBOpenDBRequest & {
        onerror: ((ev: Event) => void) | null
      }
      queueMicrotask(() => req.onerror?.(new Event('error')))
      return req
    }) as typeof globalThis.indexedDB.open
    try {
      await expect(store.get('ws-1', 'e1')).rejects.toBe(error)
    } finally {
      globalThis.indexedDB.open = originalOpen
    }
  })

  it('closes its connection on versionchange so another party can upgrade', async () => {
    // Capture the database name the store actually opens so the upgrade below
    // targets the same one rather than a hard-coded literal.
    const originalOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB)
    let dbName = ''
    globalThis.indexedDB.open = ((name: string, version?: number) => {
      dbName = name
      return originalOpen(name, version)
    }) as typeof globalThis.indexedDB.open
    try {
      await store.put('ws-1', 'e1', 'one')
    } finally {
      globalThis.indexedDB.open = originalOpen
    }
    expect(dbName).toBe('oversolved-previews')

    // An upgrader stuck on `blocked` never settles; onversionchange must let it
    // through. The cached promise is dropped with the closed connection.
    await new Promise<void>((resolve, reject) => {
      const req = globalThis.indexedDB.open(dbName, 2)
      req.onupgradeneeded = () => {}
      req.onsuccess = () => { req.result.close(); resolve() }
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('upgrade blocked: cached connection never closed'))
    })

    await expect(store.get('ws-1', 'e1')).rejects.toMatchObject({ name: 'VersionError' })
  })
})
