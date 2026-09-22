/**
 * Direct coverage of the idb.ts primitive seam: the keyed document/handle/file
 * round-trips, the store-scoped workspace helpers, and the read-modify-write
 * atomicity. The connection lifecycle and the v4 to v5 meta backfill live in
 * `idb.test.ts` one directory up; this file pins the request/transaction
 * surfaces that test does not touch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES,
  idbGet, idbGetAll, idbPut, idbDelete,
  idbGetHandle, idbPutHandle,
  idbGetFile, idbGetAllFiles, idbPutFile, idbDeleteFile, idbClearFiles,
  idbGetFrom, idbGetAllFrom, idbGetAllFromIndex, idbPutTo, idbDeleteFrom,
  idbReadModifyWrite, idbTransaction, resetDbConnection,
} from '../idb'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)

describe('document store round-trips', () => {
  it('idbPut then idbGet round-trips a record and idbGetAll returns every record', async () => {
    await idbPut({ uuid: 'a', name: 'A' })
    await idbPut({ uuid: 'b', name: 'B' })

    expect(await idbGet<{ uuid: string; name: string }>('a')).toEqual({ uuid: 'a', name: 'A' })
    expect(await idbGetAll<{ uuid: string }>()).toEqual([
      { uuid: 'a', name: 'A' },
      { uuid: 'b', name: 'B' },
    ])
  })

  it('idbGet resolves undefined for a key that was never written', async () => {
    expect(await idbGet('missing')).toBeUndefined()
  })

  it('idbDelete removes only the addressed key', async () => {
    await idbPut({ uuid: 'a', name: 'A' })
    await idbPut({ uuid: 'b', name: 'B' })

    await idbDelete('a')

    expect(await idbGet('a')).toBeUndefined()
    expect(await idbGet<{ name: string }>('b')).toEqual({ uuid: 'b', name: 'B' })
    expect(await idbGetAll()).toHaveLength(1)
  })
})

describe('handle registry (out-of-line keys)', () => {
  it('idbPutHandle/idbGetHandle round-trip a value under a caller-chosen key', async () => {
    const handle = { kind: 'directory', name: 'library' }
    await idbPutHandle('lib', handle)

    expect(await idbGetHandle<typeof handle>('lib')).toEqual(handle)
    expect(await idbGetHandle('other')).toBeUndefined()
  })
})

describe('file registry', () => {
  it('idbPutFile/idbGetFile/idbGetAllFiles and idbDeleteFile address the record id', async () => {
    await idbPutFile({ id: 'f1', bytes: new Uint8Array([1]) })
    await idbPutFile({ id: 'f2', bytes: new Uint8Array([2]) })

    const f1 = await idbGetFile<{ id: string; bytes: Uint8Array }>('f1')
    expect(f1?.id).toBe('f1')
    expect(Array.from(f1!.bytes)).toEqual([1])
    const all = await idbGetAllFiles<{ id: string; bytes: Uint8Array }>()
    expect(all.map(f => f.id)).toEqual(['f1', 'f2'])
    expect(all.map(f => Array.from(f.bytes))).toEqual([[1], [2]])

    await idbDeleteFile('f1')
    expect(await idbGetFile('f1')).toBeUndefined()
    expect(await idbGetAllFiles()).toHaveLength(1)
  })

  it('idbClearFiles empties the registry', async () => {
    await idbPutFile({ id: 'f1' })
    await idbPutFile({ id: 'f2' })

    await idbClearFiles()

    expect(await idbGetAllFiles()).toEqual([])
  })
})

describe('store-scoped workspace primitives', () => {
  it('idbPutTo/idbGetFrom/idbGetAllFrom/idbDeleteFrom address the named store', async () => {
    await idbPutTo(STORE_WORKSPACE_ENTRIES, { workspace: 'ws-1', id: 'e1', text: 'one' })
    await idbPutTo(STORE_WORKSPACE_ENTRIES, { workspace: 'ws-2', id: 'e1', text: 'two' })

    expect(await idbGetFrom(STORE_WORKSPACE_ENTRIES, ['ws-1', 'e1'])).toEqual({ workspace: 'ws-1', id: 'e1', text: 'one' })
    expect(await idbGetAllFrom<{ text: string }>(STORE_WORKSPACE_ENTRIES)).toEqual([
      { workspace: 'ws-1', id: 'e1', text: 'one' },
      { workspace: 'ws-2', id: 'e1', text: 'two' },
    ])

    await idbDeleteFrom(STORE_WORKSPACE_ENTRIES, ['ws-1', 'e1'])
    expect(await idbGetFrom(STORE_WORKSPACE_ENTRIES, ['ws-1', 'e1'])).toBeUndefined()
    expect(await idbGetFrom(STORE_WORKSPACE_ENTRIES, ['ws-2', 'e1'])).toEqual({ workspace: 'ws-2', id: 'e1', text: 'two' })
  })

  it('idbGetAllFromIndex returns only the rows matching the index key', async () => {
    await idbPutTo(STORE_WORKSPACE_ENTRIES, { workspace: 'ws-1', id: 'e1', kind: 'document', text: 'a' })
    await idbPutTo(STORE_WORKSPACE_ENTRIES, { workspace: 'ws-1', id: 'e2', kind: 'file', text: 'b' })
    await idbPutTo(STORE_WORKSPACE_ENTRIES, { workspace: 'ws-2', id: 'e1', kind: 'document', text: 'c' })

    expect(await idbGetAllFromIndex<{ text: string }>(STORE_WORKSPACE_ENTRIES, 'by_workspace', 'ws-1')).toEqual([
      { workspace: 'ws-1', id: 'e1', kind: 'document', text: 'a' },
      { workspace: 'ws-1', id: 'e2', kind: 'file', text: 'b' },
    ])
  })

  it('idbGetAllFromIndex accepts a compound key range', async () => {
    await idbPutTo(STORE_WORKSPACE_ENTRIES, { workspace: 'ws-1', id: 'e1', kind: 'document', text: 'a' })
    await idbPutTo(STORE_WORKSPACE_ENTRIES, { workspace: 'ws-1', id: 'e2', kind: 'file', text: 'b' })

    expect(await idbGetAllFromIndex<{ text: string }>(
      STORE_WORKSPACE_ENTRIES, 'by_workspace_kind', IDBKeyRange.only(['ws-1', 'document']),
    )).toEqual([{ workspace: 'ws-1', id: 'e1', kind: 'document', text: 'a' }])
  })
})

describe('idbReadModifyWrite', () => {
  it('sees no existing record, writes the mutation and returns it', async () => {
    const result = await idbReadModifyWrite<{ uuid: string; rev: number }>('k', existing => {
      expect(existing).toBeUndefined()
      return { uuid: 'k', rev: 1 }
    })

    expect(result).toEqual({ uuid: 'k', rev: 1 })
    expect(await idbGet('k')).toEqual({ uuid: 'k', rev: 1 })
  })

  it('passes the current record to the mutation and commits the replacement', async () => {
    await idbPut({ uuid: 'k', rev: 1 })

    const result = await idbReadModifyWrite<{ uuid: string; rev: number }>('k', existing => ({
      ...existing!,
      rev: existing!.rev + 1,
    }))

    expect(result).toEqual({ uuid: 'k', rev: 2 })
    expect(await idbGet('k')).toEqual({ uuid: 'k', rev: 2 })
  })

  it('skips the write when the mutation returns undefined, leaving the record untouched', async () => {
    await idbPut({ uuid: 'k', rev: 5 })

    const result = await idbReadModifyWrite<{ uuid: string; rev: number }>('k', () => undefined)

    expect(result).toBeUndefined()
    expect(await idbGet('k')).toEqual({ uuid: 'k', rev: 5 })
  })

  it('aborts and rejects when the mutation throws, leaving the old record in place', async () => {
    await idbPut({ uuid: 'k', rev: 7 })

    await expect(idbReadModifyWrite('k', () => {
      throw new Error('mutate failed')
    })).rejects.toThrow()

    expect(await idbGet('k')).toEqual({ uuid: 'k', rev: 7 })
  })

  it('commits under fake timers because the put is chained inside the read callback', async () => {
    vi.useFakeTimers()
    try {
      const pending = idbReadModifyWrite<{ uuid: string; rev: number }>('k', existing => ({
        uuid: 'k',
        rev: (existing?.rev ?? 0) + 1,
      }))
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toEqual({ uuid: 'k', rev: 1 })
    } finally {
      vi.useRealTimers()
    }

    expect(await idbGet('k')).toEqual({ uuid: 'k', rev: 1 })
  })
})

describe('error surfacing', () => {
  it('rejects a failed get request instead of resolving undefined', async () => {
    const error = new DOMException('read exploded', 'UnknownError')
    const originalGet = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function (): IDBRequest {
      const req = { result: undefined, error, onsuccess: null, onerror: null } as unknown as IDBRequest & {
        onerror: ((ev: Event) => void) | null
      }
      queueMicrotask(() => req.onerror?.(new Event('error')))
      return req
    } as typeof IDBObjectStore.prototype.get
    try {
      await expect(idbGet('anything')).rejects.toBe(error)
    } finally {
      IDBObjectStore.prototype.get = originalGet
    }
  })

  it('rejects when a put violates the store keyPath constraint', async () => {
    // `documents` is keyed by `uuid`, so a record with no keyPath cannot be
    // stored; the rejection must escape rather than be swallowed.
    await expect(idbPut({ name: 'no uuid' } as unknown as { uuid: string })).rejects.toMatchObject({ name: 'DataError' })
  })

  it('rejects and rolls back a transaction whose request errors', async () => {
    await idbPutTo(STORE_WORKSPACE_META, { workspace: 'ws-1', name: 'One' })

    // `add` on the existing key fires a real ConstraintError request, which
    // aborts the transaction; the transaction.onerror surface must reject
    // rather than resolve 'done'.
    await expect(idbTransaction([STORE_WORKSPACE_META], 'readwrite', stores => {
      stores[STORE_WORKSPACE_META].add({ workspace: 'ws-1', name: 'Duplicate' })
      return 'done'
    })).rejects.toThrow('IndexedDB transaction failed')

    expect(await idbGetFrom(STORE_WORKSPACE_META, 'ws-1')).toEqual({ workspace: 'ws-1', name: 'One' })
  })

  it('rejects when the addressed store does not exist', async () => {
    await expect(idbGetFrom('no_such_store', 'k')).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})
