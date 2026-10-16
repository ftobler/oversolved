// The connected-group union-find over picked faces. Pure, no OCC: the group is
// the unit of success/failure (OCC removes or refuses a connected set as a
// whole), so its determinism is what makes a refusal report the same faces in
// the same order across rebuilds.
import { describe, it, expect } from 'vitest'
import { unionFaceGroups } from '@/kernel/occ/defeature'

describe('unionFaceGroups', () => {
  it('leaves every face its own group when nothing is adjacent', () => {
    expect(unionFaceGroups(4, [])).toEqual([[0], [1], [2], [3]])
  })

  it('chains shared edges into one group', () => {
    expect(unionFaceGroups(3, [[0, 1], [1, 2]])).toEqual([[0, 1, 2]])
  })

  it('keeps disjoint sets apart and orders groups by their lowest index', () => {
    // Pairs given out of order; the groups come back ordered by min index.
    expect(unionFaceGroups(5, [[4, 3], [2, 0]])).toEqual([[0, 2], [1], [3, 4]])
  })

  it('tolerates repeated and reversed pairs', () => {
    expect(unionFaceGroups(3, [[0, 1], [1, 0], [0, 1]])).toEqual([[0, 1], [2]])
  })

  it('is a single group for one face', () => {
    expect(unionFaceGroups(1, [])).toEqual([[0]])
  })

  it('handles no faces at all', () => {
    expect(unionFaceGroups(0, [])).toEqual([])
  })
})
