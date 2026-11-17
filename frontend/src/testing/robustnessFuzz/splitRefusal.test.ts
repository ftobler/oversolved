// The fuzz classifies a split refusal by its message, so the matcher and the
// text `features/splitByPlane.ts` throws are one contract. A missed plane and a
// "nothing of part ... lies above/below" (one side empty after an earlier step
// moved the material) are authoring refusals and expected; anything else is a
// finding. This pins the text the matcher was updated for, not the harness.
import { describe, it, expect } from 'vitest'
import { isExpectedSplitRefusal } from '@/testing/robustnessFuzz/chain'

describe('split refusal classification', () => {
  it('expects a missed plane and an empty kept side, above or below', () => {
    expect(isExpectedSplitRefusal("split: the plane does not cross part 'body_ex1'")).toBe(true)
    expect(isExpectedSplitRefusal("split: nothing of part 'body_ex1' lies above the plane")).toBe(true)
    expect(isExpectedSplitRefusal("split: nothing of part 'body_ex1' lies below the plane")).toBe(true)
    expect(isExpectedSplitRefusal('boolean union: the kernel returned an unsound result (retry)')).toBe(true)
  })

  it('treats any other refusal text as a finding', () => {
    expect(isExpectedSplitRefusal("split: the halves of part 'body_ex1' do not add up (1 + 2 = 3)")).toBe(false)
    expect(isExpectedSplitRefusal('split: no parts picked')).toBe(false)
    expect(isExpectedSplitRefusal("split: nothing of body 'body_ex1' lies above the plane")).toBe(false)
  })
})
