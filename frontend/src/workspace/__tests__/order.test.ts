import { describe, it, expect } from 'vitest'
import { moveInOrder, resolveCustomOrder, type OrderedMeta } from '../order'

const metas: OrderedMeta[] = [
  { workspace: 'a', createdAt: 100 },
  { workspace: 'b', createdAt: 200 },
  { workspace: 'c', createdAt: 300 },
]

describe('resolveCustomOrder', () => {
  it('keeps stored slots for live workspaces', () => {
    expect(resolveCustomOrder(['c', 'a', 'b'], metas)).toEqual(['c', 'a', 'b'])
  })

  it('drops stale ids and appends missing workspaces in createdAt order', () => {
    expect(resolveCustomOrder(['stale', 'c', 'gone'], metas)).toEqual(['c', 'a', 'b'])
  })

  it('dedupes repeated ids without moving the first occurrence', () => {
    expect(resolveCustomOrder(['b', 'a', 'b'], metas)).toEqual(['b', 'a', 'c'])
  })

  it('orders an empty record oldest first, with a stable id tie-break', () => {
    expect(resolveCustomOrder([], [
      { workspace: 'z', createdAt: 100 },
      { workspace: 'y', createdAt: 100 },
      { workspace: 'x', createdAt: 50 },
    ])).toEqual(['x', 'y', 'z'])
  })

  it('keeps trashed workspaces in their slot so restoring is invisible', () => {
    const withTrash: OrderedMeta[] = [
      { workspace: 'a', createdAt: 100 },
      { workspace: 'b', createdAt: 200, trashedAt: '2026-11-23T00:00:00.000Z' },
      { workspace: 'c', createdAt: 300 },
    ]
    expect(resolveCustomOrder(['a', 'b', 'c'], withTrash)).toEqual(['a', 'b', 'c'])
  })
})

describe('moveInOrder', () => {
  it('removes then inserts at the target index', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveInOrder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
  })

  it('clamps an out of range index and ignores an unknown id', () => {
    expect(moveInOrder(['a', 'b'], 'a', 99)).toEqual(['b', 'a'])
    expect(moveInOrder(['a', 'b'], 'missing', 0)).toEqual(['a', 'b'])
  })

  it('does not mutate the input list', () => {
    const ids = ['a', 'b', 'c']
    moveInOrder(ids, 'c', 0)
    expect(ids).toEqual(['a', 'b', 'c'])
  })
})
