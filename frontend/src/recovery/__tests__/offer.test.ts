// @vitest-environment node
//
// The open-time offer decision: the journal is offered only when its snapshot
// differs from the stored text, and no failure on the way there may throw out
// of it (the editor must open regardless).
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { stringify as stringifyYaml } from 'yaml'
import { findRecoveryOffer } from '@/recovery/offer'
import { idbRecoveryJournal } from '@/recovery/journal'
import { docHashOf } from '@/drive/docHash'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartDoc } from '@/types/cad'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)

async function park(doc: PartDoc, docId = 'doc-1'): Promise<void> {
  await idbRecoveryJournal.write({
    docId,
    workspace: 'ws-1',
    updatedAt: 1000,
    docHash: docHashOf(doc),
    doc,
    repro: null,
  })
}

describe('findRecoveryOffer', () => {
  it('offers when the journal holds content the stored text does not', async () => {
    const stored = makeDoc(makeSketch('sk1', { label: 'stored' }))
    const edited = structuredClone(stored)
    edited.features![0].label = 'edited'
    await park(edited)

    const offer = await findRecoveryOffer('ws-1', 'doc-1', stringifyYaml(stored))
    expect(offer?.record.doc).toEqual(edited)
    // No thumbnail store entry: the offer is still made, just without a picture.
    expect(offer?.thumbnail).toBeNull()
  })

  it('declines when the stored text already matches the journal', async () => {
    const doc = makeDoc(makeSketch('sk1'))
    await park(doc)
    expect(await findRecoveryOffer('ws-1', 'doc-1', stringifyYaml(doc))).toBeNull()
  })

  it('declines when the journal has no record, even for unparseable text', async () => {
    expect(await findRecoveryOffer('ws-1', 'doc-1', 'not: [valid yaml')).toBeNull()
  })

  it('declines rather than throwing when the stored text will not parse', async () => {
    await park(makeDoc(makeSketch('sk1')))
    expect(await findRecoveryOffer('ws-1', 'doc-1', 'key: [unclosed')).toBeNull()
  })

  it('declines a record parked for another document', async () => {
    const doc = makeDoc(makeSketch('sk1', { label: 'other' }))
    await park(doc, 'doc-other')
    expect(await findRecoveryOffer('ws-1', 'doc-1', stringifyYaml(makeDoc()))).toBeNull()
  })
})
