// @vitest-environment node
//
// The restore handoff: parked by the open-time offer, consumed by the editor's
// loader once and only for the document the user answered for.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  requestRecoveryRestore,
  resetRecoveryRestore,
  takeRecoveryRestore,
} from '@/recovery/restore'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'

beforeEach(resetRecoveryRestore)

describe('the recovery restore handoff', () => {
  it('hands the parked snapshot to its own document once', () => {
    const doc = makeDoc(makeSketch('sk1', { label: 'restored' }))
    requestRecoveryRestore({ docId: 'doc-1', doc })

    expect(takeRecoveryRestore('doc-1')).toEqual(doc)
    // Single-use: a remount loads the store's bytes, not the snapshot again.
    expect(takeRecoveryRestore('doc-1')).toBeNull()
  })

  it('leaves the handoff parked for a different document', () => {
    const doc = makeDoc(makeSketch('sk1'))
    requestRecoveryRestore({ docId: 'doc-1', doc })

    expect(takeRecoveryRestore('doc-2')).toBeNull()
    expect(takeRecoveryRestore('doc-1')).toEqual(doc)
  })

  it('holds nothing before an offer and replaces a stale one', () => {
    expect(takeRecoveryRestore('doc-1')).toBeNull()
    const first = makeDoc(makeSketch('sk1', { label: 'first' }))
    const second = makeDoc(makeSketch('sk1', { label: 'second' }))
    requestRecoveryRestore({ docId: 'doc-1', doc: first })
    requestRecoveryRestore({ docId: 'doc-1', doc: second })
    expect(takeRecoveryRestore('doc-1')).toEqual(second)
  })
})
