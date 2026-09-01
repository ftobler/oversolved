import { describe, it, expect } from 'vitest'
import { markPositionKey } from '../markPosition'
import { IdRegistry } from '../IdRegistry'

/**
 * The position index: what it buckets together, and when it lets go.
 *
 * Its whole job is to survive the one thing a one-pixel mark cannot -- being
 * overwritten -- so the lifecycle matters as much as the key. A stale entry
 * would co-locate a recycled id with whatever used to be at that spot, which
 * is a wrong pick rather than a missing one, and worse.
 */

describe('markPositionKey', () => {
  it('buckets what float32 cannot tell apart, and nothing coarser', () => {
    // The rule is "indistinguishable to everything downstream", because float32
    // is the precision the position attribute is uploaded at. No epsilon to
    // tune, and no dependence on zoom or camera.
    expect(markPositionKey(10, 0, 0)).toBe(markPositionKey(10 + 1e-9, 0, 0))
    expect(markPositionKey(10, 0, 0)).not.toBe(markPositionKey(10 + 1e-3, 0, 0))
  })

  it('separates the axes rather than summing them', () => {
    expect(markPositionKey(1, 2, 3)).not.toBe(markPositionKey(3, 2, 1))
    expect(markPositionKey(0, 0, 0)).not.toBe(markPositionKey(0, 0, 1))
  })

  it('treats the two zeroes as one place', () => {
    // -0 and 0 are the same point; a key that split them would leave a mark
    // alone at a position another mark is also at.
    expect(markPositionKey(-0, -0, -0)).toBe(markPositionKey(0, 0, 0))
  })
})

describe('IdRegistry mark positions', () => {
  it('reports nothing for an id that marks no point', () => {
    const reg = new IdRegistry()
    const id = reg.allocate('face', 'face@A')
    expect(reg.coincidentMarkIds(id)).toEqual([])
  })

  it('reports a lone mark as itself alone', () => {
    const reg = new IdRegistry()
    const id = reg.allocate('sketchVertex', 'v1')
    reg.setMarkPosition(id, markPositionKey(1, 1, 0))
    expect(reg.coincidentMarkIds(id)).toEqual([id])
  })

  it('groups co-located marks in registration order, from either end', () => {
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    const b = reg.allocate('sketchVertex', 'b')
    const c = reg.allocate('originMarker', 'c')
    const at = markPositionKey(2, 3, 0)
    reg.setMarkPosition(a, at)
    reg.setMarkPosition(b, at)
    reg.setMarkPosition(c, at)
    expect(reg.coincidentMarkIds(a)).toEqual([a, b, c])
    expect(reg.coincidentMarkIds(c)).toEqual([a, b, c])
  })

  it('moves a mark rather than listing it in two places', () => {
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    const b = reg.allocate('sketchVertex', 'b')
    reg.setMarkPosition(a, markPositionKey(0, 0, 0))
    reg.setMarkPosition(b, markPositionKey(0, 0, 0))
    reg.setMarkPosition(a, markPositionKey(9, 9, 0))
    expect(reg.coincidentMarkIds(a)).toEqual([a])
    expect(reg.coincidentMarkIds(b)).toEqual([b])
  })

  it('drops a freed mark immediately, before the id can be recycled', () => {
    // Not at bumpCycle like the byId record: a freed id is about to be handed
    // to a re-registered primitive somewhere else, and a stale entry would
    // co-locate it with whatever used to be here.
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    const b = reg.allocate('sketchVertex', 'b')
    const at = markPositionKey(4, 4, 0)
    reg.setMarkPosition(a, at)
    reg.setMarkPosition(b, at)
    reg.free(a)
    expect(reg.coincidentMarkIds(b)).toEqual([b])
    expect(reg.coincidentMarkIds(a)).toEqual([])
    reg.bumpCycle()
    const recycled = reg.allocate('sketchVertex', 'elsewhere')
    expect(reg.coincidentMarkIds(recycled)).toEqual([])
  })

  it('forgets every position on clear', () => {
    const reg = new IdRegistry()
    const a = reg.allocate('sketchVertex', 'a')
    reg.setMarkPosition(a, markPositionKey(1, 0, 0))
    reg.clear()
    expect(reg.coincidentMarkIds(a)).toEqual([])
  })
})
