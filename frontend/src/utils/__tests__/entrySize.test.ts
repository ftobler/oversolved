import { describe, it, expect } from 'vitest'
import { entrySizeOf } from '@/utils/entrySize'

// The serialized payload size must match what TextEncoder emits byte for byte,
// so a lone surrogate counts the replacement code point (3 bytes), not a pair.

describe('entrySizeOf', () => {
  it('counts file payloads as their raw byte length', () => {
    expect(entrySizeOf({ kind: 'file', bytes: new Uint8Array([1, 2, 3]) })).toBe(3)
    expect(entrySizeOf({ kind: 'file' })).toBe(0)
  })

  it('sizes ASCII as one byte per code unit', () => {
    expect(entrySizeOf({ kind: 'document', text: 'abc' })).toBe(3)
  })

  it('counts a surrogate pair as one four-byte code point', () => {
    expect(entrySizeOf({ kind: 'document', text: '\uD83D\uDE00' })).toBe(4)
  })

  it('counts a lone high surrogate as three bytes, like TextEncoder', () => {
    expect(entrySizeOf({ kind: 'document', text: '\uD83D' })).toBe(3)
  })

  it('counts a lone low surrogate as three bytes, like TextEncoder', () => {
    expect(entrySizeOf({ kind: 'document', text: '\uDE00' })).toBe(3)
  })

  it('agrees with TextEncoder on a mixed string', () => {
    const text = 'a\u00E9\u20AC\uD83D\uDE00b\uD83Dc\uDE00d'
    expect(entrySizeOf({ kind: 'document', text })).toBe(new TextEncoder().encode(text).byteLength)
  })
})