import { describe, it, expect } from 'vitest'
import { errorMessage } from '@/utils/core/errorMessage'

describe('errorMessage', () => {
  it('uses the error message, without a String(e) "Error:" prefix', () => {
    expect(errorMessage(new Error('Document not found: doc-1'), 'Failed to load'))
      .toBe('Document not found: doc-1')
  })

  it('takes a thrown string as-is', () => {
    expect(errorMessage('kernel panic', 'Failed to solve')).toBe('kernel panic')
  })

  // The fallback exists for exactly these: a value with no readable text of its
  // own, which would otherwise render as an empty or "[object Object]" banner.
  it('falls back for a blank message, a non-Error object, and null', () => {
    expect(errorMessage(new Error('   '), 'Failed to save')).toBe('Failed to save')
    expect(errorMessage({ code: 7 }, 'Failed to save')).toBe('Failed to save')
    expect(errorMessage(null, 'Failed to save')).toBe('Failed to save')
  })
})
