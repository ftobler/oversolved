// A refused move-face split retries with replacement tools. It used to try
// EVERY subset of the usable tools: 2^n - 1 full BRepAlgoAPI_Splitter runs,
// 1023 of them for a ten-bore plate, each able to hang the worker. The budget
// is now each tool alone, then the whole set, then a named refusal.
//
// Pure loop logic, so a mocked splitter drives it with no OCC.
import { describe, it, expect } from 'vitest'
import { replacementLadders, retryReplacementSplits, type SplitAttempt } from '../moveFace'

const refuse = (): SplitAttempt => ({ picked: [], refusal: 'move_face: the neighbours do not bound the moved face' })

describe('move-face replacement budget', () => {
  it('tries each tool alone first, then the whole set', () => {
    expect(replacementLadders([0, 1, 2])).toEqual([[0], [1], [2], [0, 1, 2]])
    expect(replacementLadders([4])).toEqual([[4]])
    expect(replacementLadders([])).toEqual([])
  })

  it('calls an always-failing splitter at most n + 1 times and names the refusal', () => {
    const usable = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const calls: number[][] = []
    const out = retryReplacementSplits(usable, (subset) => {
      calls.push(subset)
      return refuse()
    })
    // 10 singles + the whole set, never the 1023 subsets.
    expect(calls).toHaveLength(usable.length + 1)
    expect(out.attempts).toBe(usable.length + 1)
    expect(calls[usable.length]).toEqual(usable)
    expect(out.picked).toEqual([])
    expect(out.refusal).toContain('move_face:')
    expect(out.refusal).toContain(`after ${usable.length + 1} split(s)`)
    expect(out.refusal).toContain('the neighbours do not bound the moved face')
  })

  it('stops at the first split that selects a cell', () => {
    const cell = { marker: 'cell' } as never
    const calls: number[][] = []
    const out = retryReplacementSplits([0, 1, 2], (subset) => {
      calls.push(subset)
      return subset.length === 1 && subset[0] === 1 ? { picked: [cell], refusal: null } : refuse()
    })
    expect(calls).toEqual([[0], [1]])
    expect(out.attempts).toBe(2)
    expect(out.picked).toEqual([cell])
    expect(out.refusal).toBeNull()
  })

  it('with nothing to try it invents no refusal; the caller keeps its own', () => {
    const out = retryReplacementSplits([], refuse)
    expect(out.attempts).toBe(0)
    expect(out.refusal).toBeNull()
    expect(out.picked).toEqual([])
  })
})
