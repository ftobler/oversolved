import { describe, it, expect } from 'vitest'
import { Repository, evictAncestryAndRegister } from './query'

describe('Repository.byUuid registration', () => {
  it('registerAncestor indexes the element by its construction uuid', () => {
    const repo = new Repository()
    const eid = repo.registerAncestor(['@extrude1', '@body_extrude1'], { type: 'face' }, 'u_abc')
    expect(repo.byUuid.get('u_abc')).toEqual([eid])
  })

  it('eviction by index tag prunes the stale byUuid entry', () => {
    const repo = new Repository()
    const indexTag = '@body_b/face0'
    evictAncestryAndRegister(repo, [indexTag, '@f1'], { type: 'face', n: 1 }, indexTag, 'u_old')
    expect(repo.byUuid.has('u_old')).toBe(true)
    // A rebuild registers a fresh payload under the same index tag: the old
    // ancestry entry (and its byUuid reference) is evicted.
    evictAncestryAndRegister(repo, [indexTag, '@f1', '@extra'], { type: 'face', n: 2 }, indexTag, 'u_new')
    expect(repo.byUuid.has('u_old')).toBe(false)
    expect(repo.byUuid.has('u_new')).toBe(true)
  })
})
