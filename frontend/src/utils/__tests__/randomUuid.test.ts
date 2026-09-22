import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUuid } from '../randomUuid'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('randomUuid', () => {
  it('prefers crypto.randomUUID and returns its value unchanged', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555')
    vi.stubGlobal('crypto', { randomUUID })

    expect(randomUuid()).toBe('11111111-2222-4333-8444-555555555555')
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('falls back to getRandomValues when crypto.randomUUID is absent, setting the v4 bits', () => {
    // Bytes 0..15 make the masked version and variant nibbles observable.
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = i
      return bytes
    })
    vi.stubGlobal('crypto', { getRandomValues })

    expect(randomUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
    expect(getRandomValues).toHaveBeenCalledTimes(1)
  })

  it('masks the variant nibble to the RFC-4122 10xx range', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xff)
      return bytes
    })
    vi.stubGlobal('crypto', { getRandomValues })

    // 0xff & 0x3f | 0x80 = 0xbf, so the variant nibble is `b` not `f`.
    expect(randomUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })
})
