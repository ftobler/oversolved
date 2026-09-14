import { describe, it, expect } from 'vitest'
import { ORIGIN_STATUS_LABEL, editedLocally, originLabel, originUpdatePolicy } from '../originsModel'
import type { EntryMeta, ProvenanceRecord } from '@/workspace/types'

function record(extra: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return { entry: 'p1', origin: 'folder:abc', originEntry: 'src1', ...extra }
}

function entry(extra: Partial<EntryMeta> = {}): EntryMeta {
  return { id: 'p1', path: 'documents/a.yaml', kind: 'document', name: 'Bracket', ...extra }
}

describe('originLabel', () => {
  it('names the source, falling back to the opaque locator', () => {
    expect(originLabel(record({ originName: 'cad' }))).toBe('cad')
    expect(originLabel(record())).toBe('folder:abc')
  })
})

describe('editedLocally', () => {
  it('is true only when both hashes are known and differ', () => {
    expect(editedLocally(record({ hash: 'aaa' }), entry({ contentHash: 'bbb' }))).toBe(true)
    expect(editedLocally(record({ hash: 'aaa' }), entry({ contentHash: 'aaa' }))).toBe(false)
    // A missing hash on either side is "cannot say", never "edited".
    expect(editedLocally(record(), entry({ contentHash: 'bbb' }))).toBe(false)
    expect(editedLocally(record({ hash: 'aaa' }), entry())).toBe(false)
    expect(editedLocally(record({ hash: 'aaa' }), undefined)).toBe(false)
  })
})

describe('originUpdatePolicy', () => {
  it('refuses a copy with no recorded source entry, and says why', () => {
    const policy = originUpdatePolicy(record({ originEntry: undefined }), entry(), 'not-updatable')
    expect(policy.canUpdate).toBe(false)
    expect(policy.title).toContain('cannot be updated')
  })

  it('refuses an unreachable origin even when the copy was edited', () => {
    const policy = originUpdatePolicy(record({ hash: 'aaa' }), entry({ contentHash: 'bbb' }), 'unreachable')
    expect(policy.canUpdate).toBe(false)
    expect(policy.title).toBe('Origin unavailable.')
  })

  it('offers the pull on a changed origin', () => {
    expect(originUpdatePolicy(record(), entry(), 'changed').canUpdate).toBe(true)
  })

  // A pull is also how a local edit is thrown away, so a current origin stays
  // pullable once the copy has drifted; the title is what warns.
  it('offers the pull on a current origin only to reset a local edit', () => {
    expect(originUpdatePolicy(record({ hash: 'aaa' }), entry({ contentHash: 'aaa' }), 'current').canUpdate).toBe(false)
    const drifted = originUpdatePolicy(record({ hash: 'aaa' }), entry({ contentHash: 'bbb' }), 'current')
    expect(drifted.canUpdate).toBe(true)
    expect(drifted.title).toContain('overwrites')
  })

  // I2: the first resolver read of a row belongs to the explicit check, so an
  // unchecked row offers no pull unless the local copy already drifted.
  it('holds the pull back until a check has run', () => {
    const unchecked = originUpdatePolicy(record(), entry(), 'unknown')
    expect(unchecked.canUpdate).toBe(false)
    expect(unchecked.title).toBe('Check for updates first.')
    expect(originUpdatePolicy(record({ hash: 'aaa' }), entry({ contentHash: 'bbb' }), 'unknown').canUpdate).toBe(true)
  })
})

describe('ORIGIN_STATUS_LABEL', () => {
  it('labels every status a row can hold', () => {
    expect(Object.keys(ORIGIN_STATUS_LABEL).sort()).toEqual(
      ['changed', 'current', 'not-updatable', 'unknown', 'unreachable'],
    )
  })
})
