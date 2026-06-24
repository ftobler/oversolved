import { describe, it, expect } from 'vitest'
import { DisposeScope, type Disposable } from './disposeScope'

class FakeObj implements Disposable {
  deleted = 0
  readonly tag: string
  private readonly order: string[]
  constructor(tag: string, order: string[]) {
    this.tag = tag
    this.order = order
  }
  delete(): void {
    this.deleted++
    this.order.push(this.tag)
  }
  isDeleted(): boolean {
    return this.deleted > 0
  }
}

describe('DisposeScope', () => {
  it('deletes tracked objects in reverse construction order', () => {
    const order: string[] = []
    const scope = new DisposeScope()
    scope.track(new FakeObj('a', order))
    scope.track(new FakeObj('b', order))
    scope.track(new FakeObj('c', order))
    scope.dispose()
    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('deletes each object exactly once and dispose() is idempotent', () => {
    const order: string[] = []
    const obj = new FakeObj('x', order)
    const scope = new DisposeScope()
    scope.track(obj)
    scope.dispose()
    scope.dispose()
    expect(obj.deleted).toBe(1)
  })

  it('does not delete a detached object', () => {
    const order: string[] = []
    const kept = new FakeObj('kept', order)
    const scope = new DisposeScope()
    scope.track(kept)
    expect(scope.size()).toBe(1)
    scope.detach(kept)
    expect(scope.size()).toBe(0)
    scope.dispose()
    expect(kept.deleted).toBe(0)
  })

  it('skips objects already deleted', () => {
    const order: string[] = []
    const obj = new FakeObj('y', order)
    obj.delete() // pre-deleted out of band
    order.length = 0
    const scope = new DisposeScope()
    scope.track(obj)
    scope.dispose()
    expect(order).toEqual([]) // isDeleted() short-circuits the second delete
  })

  it('continues disposing after one delete throws', () => {
    const order: string[] = []
    const bad: Disposable = {
      delete() {
        throw new Error('native delete failed')
      },
    }
    const good = new FakeObj('good', order)
    const scope = new DisposeScope()
    scope.track(good)
    scope.track(bad)
    expect(() => scope.dispose()).not.toThrow()
    expect(good.deleted).toBe(1)
  })

  it('throws if track() is called after dispose()', () => {
    const scope = new DisposeScope()
    scope.dispose()
    expect(() => scope.track({ delete() {} })).toThrow(/after dispose/)
  })

})
