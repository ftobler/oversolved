import { describe, it, expect } from 'vitest'
import { hashRecord, partBundleKey } from '@/workspace/contentHash'
import { sha256Hex, sha256HexBytes } from '@/kernel/sha256'

describe('hashRecord', () => {
  it('hashes a document by its text and a file by its bytes', () => {
    expect(hashRecord({ kind: 'document', text: 'abc' })).toBe(sha256Hex('abc'))
    expect(hashRecord({ kind: 'file', bytes: new Uint8Array([1, 2, 3]) })).toBe(sha256HexBytes(new Uint8Array([1, 2, 3])))
  })

  it('the kind picks the authoritative slot, so a stray other-kind payload cannot change the hash', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(hashRecord({ kind: 'document', text: 'abc', bytes })).toBe(sha256Hex('abc'))
    expect(hashRecord({ kind: 'file', text: 'abc', bytes })).toBe(sha256HexBytes(bytes))
  })
})

describe('partBundleKey', () => {
  it('is order-insensitive over the referenced file hashes', () => {
    expect(partBundleKey('d', ['b', 'a'])).toBe(partBundleKey('d', ['a', 'b']))
  })

  it('changes when a referenced file changes, which is replace-bytes invalidation', () => {
    expect(partBundleKey('d', ['f1'])).not.toBe(partBundleKey('d', ['f2']))
  })

  it('changes when the part document changes', () => {
    expect(partBundleKey('d1', [])).not.toBe(partBundleKey('d2', []))
  })
})
