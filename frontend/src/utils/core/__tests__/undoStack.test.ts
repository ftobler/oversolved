import { describe, it, expect } from 'vitest'
import { pushCapped, moveTop } from '@/utils/core/undoStack'

describe('pushCapped', () => {
  it('appends without touching the input stack', () => {
    const stack = [1, 2]
    const next = pushCapped(stack, 3, 10)
    expect(next).toEqual([1, 2, 3])
    expect(stack).toEqual([1, 2])
  })

  it('drops the oldest entry once the cap is exceeded', () => {
    expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })

  it('keeps every entry while still under the cap', () => {
    expect(pushCapped([1], 2, 3)).toEqual([1, 2])
  })
})

describe('moveTop', () => {
  it('returns null and changes nothing when the source stack is empty', () => {
    const from: number[] = []
    const to = [9]
    let built = false
    const result = moveTop(from, to, () => { built = true; return 0 })
    expect(result).toBeNull()
    expect(built).toBe(false)
    expect(to).toEqual([9])
  })

  it('pops the top of the source and appends the counterpart built from it', () => {
    const from = [{ label: 'a' }, { label: 'b' }]
    const to = [{ label: 'z' }]
    const result = moveTop(from, to, top => ({ label: `${top.label}'` }))
    expect(result).toEqual({
      from: [{ label: 'a' }],
      to: [{ label: 'z' }, { label: "b'" }],
    })
  })

  it('leaves both input arrays unmodified', () => {
    const from = [1, 2]
    const to = [3]
    moveTop(from, to, top => top * 10)
    expect(from).toEqual([1, 2])
    expect(to).toEqual([3])
  })

  it('conserves the total entry count across the move', () => {
    const from = [1, 2, 3]
    const to = [4, 5]
    const result = moveTop(from, to, top => top)
    expect(result).not.toBeNull()
    expect(result!.from.length + result!.to.length).toBe(from.length + to.length)
  })
})
