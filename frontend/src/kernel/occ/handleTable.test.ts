import { describe, it, expect, vi } from 'vitest'
import { HandleTable, type OccHandle } from './handleTable'
import type { Disposable } from './disposeScope'

class FakeShape implements Disposable {
  deleted = 0
  readonly tag: string
  constructor(tag: string) {
    this.tag = tag
  }
  delete(): void {
    this.deleted++
  }
  isDeleted(): boolean {
    return this.deleted > 0
  }
}

// The guard relies on FinalizationRegistry timing, which is nondeterministic,
// so the tests keep it off and exercise the deterministic refcount paths.
function table() {
  return new HandleTable({ finalizerGuard: false })
}

describe('HandleTable', () => {
  it('registers at refcount 1 and finalizes on release', () => {
    const t = table()
    const s = new FakeShape('a')
    const h = t.register(s)
    expect(t.liveCount()).toBe(1)
    expect(t.get(h)).toBe(s)
    t.release(h)
    expect(t.liveCount()).toBe(0)
    expect(s.deleted).toBe(1)
  })

  it('keeps a shape alive until the last reference releases', () => {
    const t = table()
    const s = new FakeShape('shared')
    const h = t.register(s)
    t.retain(h)
    t.retain(h)
    t.release(h)
    t.release(h)
    expect(s.deleted).toBe(0)
    expect(t.has(h)).toBe(true)
    t.release(h)
    expect(s.deleted).toBe(1)
    expect(t.has(h)).toBe(false)
  })

  it('releaseOwner drops every handle a checkpoint held', () => {
    const t = table()
    const a = new FakeShape('a')
    const b = new FakeShape('b')
    const ha = t.register(a, 'feat1')
    const hb = t.register(b, 'feat1')
    expect(t.liveCount()).toBe(2)
    t.releaseOwner('feat1')
    expect(t.liveCount()).toBe(0)
    expect(a.deleted).toBe(1)
    expect(b.deleted).toBe(1)
    void ha
    void hb
  })

  it('a shape shared across owners survives until both evict', () => {
    const t = table()
    const s = new FakeShape('shared-by-lineage')
    const h = t.register(s, 'feat1')
    t.retain(h, 'feat2') // feat2 inherits the same shape via lineage
    t.releaseOwner('feat1')
    expect(s.deleted).toBe(0) // feat2 still holds it
    expect(t.has(h)).toBe(true)
    t.releaseOwner('feat2')
    expect(s.deleted).toBe(1)
  })

  it('throws on use-after-free', () => {
    const t = table()
    const h = t.register(new FakeShape('x'))
    t.release(h)
    expect(() => t.get(h)).toThrow(/not live/)
    expect(() => t.release(h)).toThrow(/not live/)
  })

  it('assertNoLeaks throws with detail when handles remain', () => {
    const t = table()
    t.register(new FakeShape('leaked'), 'featX')
    expect(() => t.assertNoLeaks()).toThrow(/1 leaked handle/)
    expect(() => t.assertNoLeaks()).toThrow(/featX/)
  })

  it('assertNoLeaks passes when empty', () => {
    const t = table()
    const h = t.register(new FakeShape('ok'))
    t.release(h)
    expect(() => t.assertNoLeaks()).not.toThrow()
  })

  it('disposeAll deletes everything regardless of refcount', () => {
    const t = table()
    const a = new FakeShape('a')
    const b = new FakeShape('b')
    t.retain(t.register(a))
    t.register(b)
    t.disposeAll()
    expect(t.liveCount()).toBe(0)
    expect(a.deleted).toBe(1)
    expect(b.deleted).toBe(1)
  })

  it('finalize swallows a failing native delete', () => {
    const t = table()
    const bad: Disposable = {
      delete() {
        throw new Error('native delete failed')
      },
    }
    const h = t.register(bad)
    expect(() => t.release(h)).not.toThrow()
    expect(t.liveCount()).toBe(0)
  })

  it('does not double-delete a shape OCC already deleted out of band', () => {
    const t = table()
    const s = new FakeShape('already')
    const h = t.register(s)
    s.delete() // some OCC op deleted it underneath us
    t.release(h)
    expect(s.deleted).toBe(1) // isDeleted() guard prevents the second delete
  })

  it('stays leak-free across a 100-iteration register/release loop', () => {
    const t = table()
    const all: FakeShape[] = []
    for (let i = 0; i < 100; i++) {
      const owner = `feat${i}`
      const handles: OccHandle[] = []
      for (let j = 0; j < 5; j++) {
        const s = new FakeShape(`${owner}:${j}`)
        all.push(s)
        handles.push(t.register(s, owner))
      }
      // one shape shared into the next "feature" via lineage
      t.retain(handles[0], `feat${i + 1}`)
      t.releaseOwner(owner)
      void handles
    }
    // the final iteration left one retained handle for the (nonexistent) next feature
    t.releaseOwner('feat100')
    expect(t.liveCount()).toBe(0)
    t.assertNoLeaks()
    expect(all.every((s) => s.deleted === 1)).toBe(true)
  })

  it('the finalizer guard wires up without throwing when enabled', () => {
    const onLeak = vi.fn()
    const t = new HandleTable({ finalizerGuard: true, onLeak })
    const h = t.register(new FakeShape('g'))
    t.release(h)
    t.assertNoLeaks()
  })
})
