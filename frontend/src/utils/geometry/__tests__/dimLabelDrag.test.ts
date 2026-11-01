import { describe, it, expect } from 'vitest'
import { dimLabelCommitOffset, DIM_LABEL_MIN_TRAVEL } from '@/utils/geometry/dimLabelDrag'

describe('dimLabelCommitOffset', () => {
  it('commits the anchor-relative offset once the label has moved', () => {
    expect(dimLabelCommitOffset([3, 4], [0, 0])).toEqual([3, 4])
    expect(dimLabelCommitOffset([10, 5], [7, 5])).toEqual([3, 0])
  })

  it('does not commit a label that never left its anchor', () => {
    expect(dimLabelCommitOffset([0, 0], [0, 0])).toBeNull()
  })

  it('rejects travel below the threshold in any direction', () => {
    expect(dimLabelCommitOffset([DIM_LABEL_MIN_TRAVEL / 2, 0], [0, 0])).toBeNull()
    expect(dimLabelCommitOffset([0, -DIM_LABEL_MIN_TRAVEL / 2], [0, 0])).toBeNull()
  })

  it('commits exactly at the threshold', () => {
    expect(dimLabelCommitOffset([DIM_LABEL_MIN_TRAVEL, 0], [0, 0])).toEqual([DIM_LABEL_MIN_TRAVEL, 0])
  })
})
