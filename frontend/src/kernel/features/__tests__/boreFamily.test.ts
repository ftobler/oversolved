// The bore uuids a threaded hole reports for the viewport to shade: the bore
// itself, or the split pieces the cut left, found by name derivation alone.
// The real-kernel slot case lives in holeThreadReal.test.ts; this pins the
// naming walk, including a piece that a later site split again.
import { describe, it, expect } from 'vitest'
import { mintFaceUuid, splitFacePath } from '../../constructionName'
import { boreFamily } from '../hole'

const child = (parent: string, i: number) => mintFaceUuid(splitFacePath(parent, i))
const BORE = 'u_bore'
const OTHERS = ['u_top', 'u_floor', 'u_side']

describe('boreFamily', () => {
  it('is the bore alone when it survived whole', () => {
    expect(boreFamily(BORE, new Set([BORE, ...OTHERS]))).toEqual([BORE])
  })

  it('is every split piece when the bore crossed a gap', () => {
    const pieces = [child(BORE, 0), child(BORE, 1)]
    expect(boreFamily(BORE, new Set([...pieces, ...OTHERS])).sort()).toEqual([...pieces].sort())
  })

  it('follows a piece that was split again, even though that piece is gone', () => {
    const c0 = child(BORE, 0)
    const c1 = child(BORE, 1)
    const grandchildren = [child(c0, 0), child(c0, 1)]
    // c0 itself is absent: a later site of the same hole split it.
    const present = new Set([c1, ...grandchildren, ...OTHERS])
    expect(boreFamily(BORE, present).sort()).toEqual([c1, ...grandchildren].sort())
  })

  it('skips a piece a later cut consumed outright and keeps the pieces after it', () => {
    // Child 1 is gone with no descendants: a gap in the numbering, not the end.
    const kept = [child(BORE, 0), child(BORE, 2)]
    expect(boreFamily(BORE, new Set([...kept, ...OTHERS])).sort()).toEqual([...kept].sort())
  })

  it('is empty when no piece of the bore survived', () => {
    expect(boreFamily(BORE, new Set(OTHERS))).toEqual([])
  })
})
