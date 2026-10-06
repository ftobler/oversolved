import { describe, it, expect } from 'vitest'
import { DisposeScope, drainList, withTransientScope, type Disposable } from '../disposeScope'
import type { OccListOfShape, OccShape } from '../occTypes'

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

/** A fake TopTools_ListOfShape: Size/First_1/RemoveFirst, plus delete tracking
 *  for the container itself. */
class FakeList implements OccListOfShape {
  deleted = 0
  private readonly items: FakeObj[]
  constructor(items: FakeObj[]) {
    this.items = items
  }
  Size(): number {
    return this.items.length
  }
  First_1(): OccShape {
    return this.items[0]
  }
  RemoveFirst(): void {
    this.items.shift()
  }
  Append_1(): void {
    throw new Error('not used by drainList')
  }
  delete(): void {
    this.deleted++
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

  it('isTracked reports whether an object is currently in the scope', () => {
    const scope = new DisposeScope()
    const obj = new FakeObj('x', [])
    expect(scope.isTracked(obj)).toBe(false)
    scope.track(obj)
    expect(scope.isTracked(obj)).toBe(true)
    scope.detach(obj)
    expect(scope.isTracked(obj)).toBe(false)
  })

  it('detach throws on an object the scope never tracked', () => {
    const scope = new DisposeScope()
    const foreign = new FakeObj('foreign', [])
    expect(() => scope.detach(foreign)).toThrow(/untracked/)
    // A no-op detach would hand the caller a shape it does not own; registering
    // it puts a second owner on a proxy someone else will delete.
    expect(scope.size()).toBe(0)
  })

  it('skips objects already deleted', () => {
    const order: string[] = []
    const obj = new FakeObj('y', order)
    obj.delete()  // pre-deleted out of band
    order.length = 0
    const scope = new DisposeScope()
    scope.track(obj)
    scope.dispose()
    expect(order).toEqual([])  // isDeleted() short-circuits the second delete
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

describe('DisposeScope.release', () => {
  it('deletes immediately and keeps dispose() from deleting again', () => {
    const order: string[] = []
    const obj = new FakeObj('x', order)
    const scope = new DisposeScope()
    scope.track(obj)
    scope.release(obj)
    expect(obj.deleted).toBe(1)
    order.length = 0
    scope.dispose()
    expect(order).toEqual([])  // already released: nothing left to free
  })

  it('drops every tracking entry of an object tracked twice', () => {
    const obj = new FakeObj('dup', [])
    const scope = new DisposeScope()
    scope.track(obj)
    scope.track(obj)  // e.g. a face handed through two producers
    expect(scope.size()).toBe(2)
    scope.release(obj)
    expect(scope.size()).toBe(0)
    scope.dispose()
    expect(obj.deleted).toBe(1)  // freed once, not per stale entry
  })

  it('still frees an object that was never tracked', () => {
    const obj = new FakeObj('foreign', [])
    const scope = new DisposeScope()
    scope.release(obj)
    expect(obj.deleted).toBe(1)
  })

  it('survives a failed native delete', () => {
    const bad: Disposable = { delete() { throw new Error('native delete failed') } }
    const scope = new DisposeScope()
    scope.track(bad)
    expect(() => scope.release(bad)).not.toThrow()
  })
})

describe('drainList', () => {
  it('frees both the drained shapes and the list container itself', () => {
    const order: string[] = []
    const a = new FakeObj('a', order)
    const b = new FakeObj('b', order)
    const list = new FakeList([a, b])
    const scope = new DisposeScope()

    const out = drainList(scope, list)

    expect(out).toEqual([a, b])
    expect(list.deleted).toBe(0)  // not deleted yet, only tracked
    scope.dispose()
    expect(list.deleted).toBe(1)
    expect(a.deleted).toBe(1)
    expect(b.deleted).toBe(1)
  })
})

describe('withTransientScope', () => {
  it('disposes the child scope on the return path', () => {
    const order: string[] = []
    const out = withTransientScope((s) => {
      s.track(new FakeObj('inner', order))
      return 'result'
    })
    expect(out).toBe('result')
    expect(order).toEqual(['inner'])
  })

  it('disposes the child scope on the throw path and rethrows unchanged', () => {
    const order: string[] = []
    const boom = new Error('boom')
    let caught: unknown
    try {
      withTransientScope((s) => {
        s.track(new FakeObj('inner', order))
        throw boom
      })
    } catch (e) {
      caught = e
    }
    // The same error object must surface, not a rewrap -- a caller's
    // `extractErrorMessage` downstream sees the original message.
    expect(caught).toBe(boom)
    expect(order).toEqual(['inner'])
  })

  it('does not dispose the caller-owned scope the child reads from', () => {
    const order: string[] = []
    const outer = new DisposeScope()
    outer.track(new FakeObj('outer', order))
    const out = withTransientScope((s) => {
      s.track(new FakeObj('inner', order))
      return outer.size()
    })
    expect(out).toBe(1)  // the child's dispose() must not touch the outer scope
    expect(order).toEqual(['inner'])
    outer.dispose()
    expect(order).toEqual(['inner', 'outer'])
  })
})
