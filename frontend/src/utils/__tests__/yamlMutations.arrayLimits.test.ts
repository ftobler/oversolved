import { describe, it, expect, vi } from 'vitest'
import { applyAddPattern, applySetPatternField } from '../yamlMutations/index'
import type { PartDoc } from '@/types/cad'

function doc(): PartDoc {
  return {
    features: [
      {
        id: 'a1', kind: 'pattern',
        pattern: { subject: 'body', mode: 'rectangular', count_x: 2, count_y: 3 },
      },
      {
        id: 'c1', kind: 'pattern',
        pattern: { subject: 'body', mode: 'circular', count: 4 },
      },
    ],
  } as unknown as PartDoc
}

describe('pattern count mutations honour the loader limits', () => {
  it('refuses count_x past the cap and leaves the doc unchanged', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    const before = JSON.stringify(d)
    applySetPatternField(d, 'a1', 'count_x', 2000)
    expect(JSON.stringify(d)).toBe(before)
  })

  it('refuses a pair past the cells cap', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    applySetPatternField(d, 'a1', 'count_y', 300)
    applySetPatternField(d, 'a1', 'count_x', 400)
    const sub = (d.features![0] as { pattern: { count_x: number } }).pattern
    expect(sub.count_x).toBe(2)
  })

  it('refuses an inline add past the caps and adds nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    applyAddPattern(d, 'a2', undefined, { mode: 'rectangular', count_x: 2000 })
    applyAddPattern(d, 'a3', undefined, { mode: 'rectangular', count_x: 400, count_y: 300 })
    applyAddPattern(d, 'c2', undefined, { mode: 'circular', count: 1001 })
    expect(d.features).toHaveLength(2)
    applyAddPattern(d, 'a4', undefined, { mode: 'rectangular', count_x: 1000 })
    expect(d.features).toHaveLength(3)
  })

  it('accepts the boundary', () => {
    const d = doc()
    applySetPatternField(d, 'c1', 'count', 1000)
    expect((d.features![1] as { pattern: { count: number } }).pattern.count).toBe(1000)
    applySetPatternField(d, 'c1', 'count', 1001)
    expect((d.features![1] as { pattern: { count: number } }).pattern.count).toBe(1000)
  })
})
