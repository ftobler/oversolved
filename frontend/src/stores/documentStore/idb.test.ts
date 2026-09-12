/**
 * Robustness of the idb.ts open seam (L10/L11): a rejected open must not be
 * memoized forever, and the cached connection must yield when another party
 * upgrades the database. Round-trip behaviour itself is exercised through the
 * document store tests; these cases pin the connection lifecycle.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  DB_NAME, DB_VERSION, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META, STORE_WORKSPACE_META,
  idbGet, idbGetAllFrom, idbGetFrom,
  idbPut, idbTransaction, resetDbConnection,
} from './idb'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)

describe('idb open robustness', () => {
  it('recovers on the next call after a failed open, without resetDbConnection', async () => {
    // A broken factory poisons the open once; the module must drop the
    // rejected promise itself so later calls retry instead of replaying the
    // failure for the rest of the session.
    const real = globalThis.indexedDB
    globalThis.indexedDB = { open: () => { throw new Error('transient open failure') } } as unknown as IDBFactory
    await expect(idbGet('a')).rejects.toThrow('transient open failure')

    globalThis.indexedDB = real
    await idbPut({ uuid: 'doc1', name: 'Doc 1' })
    expect(await idbGet<{ uuid: string }>('doc1')).toMatchObject({ uuid: 'doc1' })
  })

  it('closes its connection on versionchange so an upgrade by another party can proceed', async () => {
    // Caches a live connection at the module's pinned version first.
    await idbPut({ uuid: 'doc1', name: 'Doc 1' })

    // An upgrader stuck on `blocked` would never settle and fail this test
    // on timeout; the module's onversionchange close must let it through.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION + 1)
      req.onupgradeneeded = () => {}
      req.onsuccess = () => { req.result.close(); resolve() }
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('upgrade blocked: cached connection never closed'))
    })

    // The cached promise was dropped along with the closed connection, so the
    // next use attempts a genuine reopen. Its pinned DB_VERSION is older than
    // the upgraded database, which is exactly the VersionError a pre-upgrade
    // tab should see; replaying the CLOSED connection instead would surface
    // InvalidStateError forever.
    try {
      await idbGet('doc1')
      expect.unreachable('expected a VersionError against the upgraded database')
    } catch (e) {
      expect((e as DOMException).name).toBe('VersionError')
    }
  })
})

describe('payload-free entry meta backfill (v4 to v5)', () => {
  it('projects existing working-copy rows into the meta mirror on upgrade', async () => {
    // Build a v4 database by hand with one populated working-copy entry.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 4)
      req.onupgradeneeded = () => {
        const db = req.result
        db.createObjectStore(STORE_WORKSPACE_META, { keyPath: 'workspace' })
        const entries = db.createObjectStore(STORE_WORKSPACE_ENTRIES, { keyPath: ['workspace', 'id'] })
        entries.put({
          workspace: 'ws', id: 'e1', path: 'documents/A.yaml', kind: 'document',
          name: 'A', docKind: 'part', text: 'body', rev: 3, updatedAt: 9,
        })
      }
      req.onsuccess = () => { req.result.close(); resolve() }
      req.onerror = () => reject(req.error)
    })
    resetDbConnection()

    // The next v5 open upgrades and backfills the mirror.
    const metas = await idbGetAllFrom<Record<string, unknown>>(STORE_WORKSPACE_ENTRY_META)
    expect(metas).toEqual([
      { workspace: 'ws', id: 'e1', path: 'documents/A.yaml', kind: 'document', name: 'A', docKind: 'part', rev: 3, updatedAt: 9 },
    ])
  })
})

describe('idbTransaction (I7, multi-key atomicity)', () => {
  it('commits every store and resolves once the transaction completes', async () => {
    const result = await idbTransaction(
      [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES],
      'readwrite',
      stores => {
        stores[STORE_WORKSPACE_META].put({ workspace: 'ws-1', name: 'One' })
        stores[STORE_WORKSPACE_ENTRIES].put({ workspace: 'ws-1', id: 'e1', text: 'body' })
        return 'done'
      },
    )
    expect(result).toBe('done')
    expect(await idbGetFrom(STORE_WORKSPACE_META, 'ws-1')).toEqual({ workspace: 'ws-1', name: 'One' })
    expect(await idbGetFrom(STORE_WORKSPACE_ENTRIES, ['ws-1', 'e1'])).toEqual({ workspace: 'ws-1', id: 'e1', text: 'body' })
  })

  it('aborts the whole unit when build throws, leaving every store untouched', async () => {
    await idbTransaction(
      [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES],
      'readwrite',
      stores => {
        stores[STORE_WORKSPACE_META].put({ workspace: 'ws-2', name: 'Old' })
        stores[STORE_WORKSPACE_ENTRIES].put({ workspace: 'ws-2', id: 'e1', text: 'old' })
      },
    )

    await expect(idbTransaction(
      [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES],
      'readwrite',
      stores => {
        stores[STORE_WORKSPACE_META].put({ workspace: 'ws-2', name: 'New' })
        stores[STORE_WORKSPACE_ENTRIES].put({ workspace: 'ws-2', id: 'e1', text: 'new' })
        throw new Error('injected failure')
      },
    )).rejects.toThrow('injected failure')

    expect(await idbGetFrom(STORE_WORKSPACE_META, 'ws-2')).toEqual({ workspace: 'ws-2', name: 'Old' })
    expect(await idbGetFrom(STORE_WORKSPACE_ENTRIES, ['ws-2', 'e1'])).toEqual({ workspace: 'ws-2', id: 'e1', text: 'old' })
  })
})
