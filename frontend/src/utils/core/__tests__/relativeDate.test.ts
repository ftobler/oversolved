import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatRelativeDate } from '@/utils/core/relativeDate'

afterEach(() => { vi.useRealTimers() })

describe('formatRelativeDate', () => {
  it('returns empty string for an empty input', () => {
    expect(formatRelativeDate('')).toBe('')
  })

  it('does not throw and returns empty string for a malformed isoString', () => {
    expect(() => formatRelativeDate('not-a-date')).not.toThrow()
    expect(formatRelativeDate('not-a-date')).toBe('')
  })

  it('clamps a future timestamp to a non-negative "just now" result', () => {
    const now = new Date('2026-08-22T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const future = new Date(now.getTime() + 5000).toISOString()
    expect(formatRelativeDate(future)).toBe('0s ago')
  })

  it('formats a recent past timestamp in seconds', () => {
    const now = new Date('2026-08-22T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const past = new Date(now.getTime() - 5000).toISOString()
    expect(formatRelativeDate(past)).toBe('5s ago')
  })

  it('formats minutes ago', () => {
    const now = new Date('2026-08-22T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const past = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
    expect(formatRelativeDate(past)).toBe('5min ago')
  })

  it('formats hours ago', () => {
    const now = new Date('2026-08-22T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const past = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeDate(past)).toBe('5h ago')
  })

  it('falls back to a calendar date beyond 24h', () => {
    const now = new Date('2026-08-22T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const past = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeDate(past)).toBe('Aug 19, 2026')
  })
})
