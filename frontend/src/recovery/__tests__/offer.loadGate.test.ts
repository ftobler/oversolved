// @vitest-environment node
//
// The recovery snapshot crosses the same load gate as the stored bytes: an old
// one is migrated before it is offered, a refused one yields no offer.
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

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
})

async function park(doc: unknown): Promise<void> {
  await idbRecoveryJournal.write({
    docId: 'doc-1',
    workspace: 'ws-1',
    updatedAt: 1000,
    docHash: docHashOf(doc as PartDoc),
    doc: doc as PartDoc,
    repro: null,
  })
}

describe('findRecoveryOffer load gate', () => {
  it('offers the migrated document for an older journal record', async () => {
    const stored = stringifyYaml(makeDoc(makeSketch('sk1')))
    await park({
      version: 1,
      features: [{ id: 'd1', kind: 'delete_body', delete_body: { body: 'extrude1' } }],
    })
    const offer = await findRecoveryOffer('ws-1', 'doc-1', stored)
    const feature = offer?.record.doc.features?.[0] as { delete_body: { bodies?: string[]; body?: string } }
    expect(feature.delete_body.bodies).toEqual(['extrude1'])
    expect(feature.delete_body.body).toBeUndefined()
  })

  it('declines a record the loader refuses', async () => {
    const stored = stringifyYaml(makeDoc(makeSketch('sk1')))
    await park({ features: [{ id: 'a1', kind: 'array', array: { count_x: 5000 } }] })
    expect(await findRecoveryOffer('ws-1', 'doc-1', stored)).toBeNull()
  })
})
