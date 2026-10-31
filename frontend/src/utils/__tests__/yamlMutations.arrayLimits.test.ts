import { describe, it, expect, vi } from 'vitest'
import { applyAddArray, applyAddCircularArray, applySetArrayField, applySetCircularArrayField } from '../yamlMutations/index'
import type { PartDoc } from '@/types/cad'

function doc(): PartDoc {
  return {
    features: [
      { id: 'a1', kind: 'array', array: { mode: 'rectangular', count_x: 2, count_y: 3 } },
      { id: 'c1', kind: 'circular_array', circular_array: { count: 4 } },
    ],
  } as unknown as PartDoc
}

describe('array count mutations honour the loader limits', () => {
  it('refuses count_x past the cap and leaves the doc unchanged', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    const before = JSON.stringify(d)
    applySetArrayField(d, 'a1', 'count_x', 2000)
    expect(JSON.stringify(d)).toBe(before)
  })

  it('refuses a pair past the cells cap', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    applySetArrayField(d, 'a1', 'count_y', 300)
    applySetArrayField(d, 'a1', 'count_x', 400)
    const sub = (d.features![0] as { array: { count_x: number } }).array
    expect(sub.count_x).toBe(2)
  })

  it('refuses an inline add past the caps and adds nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = doc()
    applyAddArray(d, 'a2', undefined, { count_x: 2000 })
    applyAddArray(d, 'a3', undefined, { mode: 'rectangular', count_x: 400, count_y: 300 })
    applyAddCircularArray(d, 'c2', undefined, { count: 1001 })
    expect(d.features).toHaveLength(2)
    applyAddArray(d, 'a4', undefined, { count_x: 1000 })
    expect(d.features).toHaveLength(3)
  })

  it('accepts the boundary', () => {
    const d = doc()
    applySetCircularArrayField(d, 'c1', 'count', 1000)
    expect((d.features![1] as { circular_array: { count: number } }).circular_array.count).toBe(1000)
    applySetCircularArrayField(d, 'c1', 'count', 1001)
    expect((d.features![1] as { circular_array: { count: number } }).circular_array.count).toBe(1000)
  })
})
