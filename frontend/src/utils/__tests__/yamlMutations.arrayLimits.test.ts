import { describe, it, expect, vi } from 'vitest'
import { applyAddLinearPattern, applySetLinearPatternField } from '../yamlMutations/index'
import type { PartDoc } from '@/types/cad'

function doc(): PartDoc {
  return {
    features: [
      {
        id: 'a1', kind: 'linear_pattern',
        linear_pattern: { subject: 'body', second_direction: true, count: 2, count_2: 3 },
      },
    ],
  } as unknown as PartDoc
}

describe('pattern count mutations honour the loader limits', () => {
  it('refuses count_2 past the cap and leaves the doc unchanged', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    const before = JSON.stringify(d)
    applySetLinearPatternField(d, 'a1', 'count_2', 2000)
    expect(JSON.stringify(d)).toBe(before)
  })

  it('refuses a pair past the cells cap', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    applySetLinearPatternField(d, 'a1', 'count_2', 300)
    applySetLinearPatternField(d, 'a1', 'count', 400)
    const sub = (d.features![0] as { linear_pattern: { count: number } }).linear_pattern
    expect(sub.count).toBe(2)
  })

  it('refuses an inline add past the caps and adds nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    applyAddLinearPattern(d, 'a2', undefined, { second_direction: true, count: 2000 })
    applyAddLinearPattern(d, 'a3', undefined, { second_direction: true, count: 400, count_2: 300 })
    expect(d.features).toHaveLength(1)
    applyAddLinearPattern(d, 'a4', undefined, { count: 1000 })
    expect(d.features).toHaveLength(2)
  })

  it('accepts the boundary', () => {
    const d = doc()
    applySetLinearPatternField(d, 'a1', 'count', 1000)
    expect((d.features![0] as { linear_pattern: { count: number } }).linear_pattern.count).toBe(1000)
    applySetLinearPatternField(d, 'a1', 'count', 1001)
    expect((d.features![0] as { linear_pattern: { count: number } }).linear_pattern.count).toBe(1000)
  })
})
