/**
 * Robustness of the idb.ts open seam (L10/L11): a rejected open must not be
 * memoized forever, and the cached connection must yield when another party
 * upgrades the database. Round-trip behaviour itself is exercised through the
 * document store tests; these cases pin the connection lifecycle.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { DB_NAME, idbGet, idbPut, resetDbConnection } from './idb'

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
    // Caches a live v1 connection first.
    await idbPut({ uuid: 'doc1', name: 'Doc 1' })

    // An upgrader stuck on `blocked` would never settle and fail this test
    // on timeout; the module's onversionchange close must let it through.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2)
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
