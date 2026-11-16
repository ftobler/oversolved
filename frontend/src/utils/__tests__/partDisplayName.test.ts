import { describe, it, expect } from 'vitest'
import { partDisplayName } from '@/utils/core/partDisplayName'

describe('partDisplayName', () => {
  it('rename wins', () => {
    expect(partDisplayName('b1', { b1: 'My Part' }, ['b1'])).toBe('My Part')
  })
  it('fallback numbering matches partStyle after deleted body', () => {
    // body b1 deleted; b2 survives with part 1? Actually b1 part1 used, b2 gets part2.
    const labels = { b1: 'part 1' }
    // ordered only b2
    expect(partDisplayName('b2', labels, ['b2'])).toBe('part 2')
  })
  it('first body gets part 1 when none', () => {
    expect(partDisplayName('b1', {}, ['b1', 'b2'])).toBe('part 1')
  })
})
