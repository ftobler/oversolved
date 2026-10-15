// @vitest-environment node
//
// The recovery journal's storage face, driven against a real fake-indexeddb
// database: round trips, replacement per document, the clear seam, the
// ahead-of-the-stored-document decision, and the v8 upgrade that creates the
// store for a database written at the previous version.
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  DB_NAME,
  STORE_RECOVERY_JOURNAL,
  idbGetFrom,
  resetDbConnection,
} from '@/stores/documentStore/idb'
import {
  clearRecoveryJournal,
  idbRecoveryJournal,
  readRecoveryJournal,
  recoveryAhead,
  type RecoveryJournalRecord,
} from '@/recovery/journal'
import { docHashOf } from '@/drive/docHash'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import type { PartDoc } from '@/types/cad'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)

function record(doc: PartDoc, overrides: Partial<RecoveryJournalRecord> = {}): RecoveryJournalRecord {
  return {
    docId: 'doc-1',
    workspace: 'ws-1',
    updatedAt: 1000,
    docHash: docHashOf(doc),
    doc,
    repro: null,
    ...overrides,
  }
}

describe('recovery journal store', () => {
  it('round-trips a record keyed by document uuid', async () => {
    const doc = makeDoc(makeSketch('sk1'))
    await idbRecoveryJournal.write(record(doc))

    const read = await readRecoveryJournal('doc-1')
    expect(read?.docId).toBe('doc-1')
    expect(read?.workspace).toBe('ws-1')
    expect(read?.docHash).toBe(docHashOf(doc))
    expect(read?.doc).toEqual(doc)
    expect(read?.repro).toBeNull()
  })

  it('replaces the previous record for the same document instead of stacking', async () => {
    const first = makeDoc(makeSketch('sk1', { label: 'first' }))
    const second = makeDoc(makeSketch('sk1', { label: 'second' }))
    await idbRecoveryJournal.write(record(first))
    await idbRecoveryJournal.write(record(second, { updatedAt: 2000 }))

    const read = await readRecoveryJournal('doc-1')
    expect(read?.updatedAt).toBe(2000)
    expect(read?.docHash).toBe(docHashOf(second))
  })

  it('keeps documents apart and clears only the addressed one', async () => {
    await idbRecoveryJournal.write(record(makeDoc(makeSketch('sk1', { label: 'a' })), { docId: 'doc-a' }))
    await idbRecoveryJournal.write(record(makeDoc(makeSketch('sk1', { label: 'b' })), { docId: 'doc-b' }))

    await clearRecoveryJournal('doc-a')
    expect(await readRecoveryJournal('doc-a')).toBeUndefined()
    expect((await readRecoveryJournal('doc-b'))?.docId).toBe('doc-b')
  })

  it('creates the store when opening a database written before v8', async () => {
    // A v7 database of the app's name, empty because the v8 upgrade creates
    // every store conditionally. The next helper call reopens at v8.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 7)
      req.onsuccess = () => { req.result.close(); resolve() }
      req.onerror = () => reject(req.error)
    })
    resetDbConnection()

    await idbRecoveryJournal.write(record(makeDoc(makeSketch('sk1'))))
    expect(await idbGetFrom<RecoveryJournalRecord>(STORE_RECOVERY_JOURNAL, 'doc-1')).toMatchObject({ docId: 'doc-1' })
  })
})

describe('recoveryAhead', () => {
  it('reports a journal whose snapshot differs from the stored document', () => {
    const stored = makeDoc(makeSketch('sk1', { label: 'stored' }))
    const edited = makeDoc(makeSketch('sk1', { label: 'edited' }))
    expect(recoveryAhead(stored, record(edited))).toBe(true)
    expect(recoveryAhead(stored, record(stored))).toBe(false)
  })

  it('never offers a restore when nothing is stored to restore over', () => {
    const doc = makeDoc(makeSketch('sk1'))
    expect(recoveryAhead(null, record(doc))).toBe(false)
  })

  it('ignores the write time, so a surviving record that matches the store is not offered', () => {
    // A clear that failed after an explicit save leaves a record that is newer
    // by clock but byte-equal to what is stored; the hash decides.
    const doc = makeDoc(makeSketch('sk1'))
    expect(recoveryAhead(doc, record(doc, { updatedAt: Date.now() + 60_000 }))).toBe(false)
  })
})
