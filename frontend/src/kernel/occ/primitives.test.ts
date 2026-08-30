// @vitest-environment node
//
// Unit tests for the hash-bucketed dedup helpers that replaced the old O(n^2)
// `some(IsSame)` accumulating-list scans. No OCC needed: stub shapes carry just
// the two methods `SubShapeDedup`/`SubShapeIndexMap` touch, so the semantics of
// the routing (first-wins, identical-dedup, distinct-kept, hash-collision-safe)
// are pinned without a WASM build.

import { describe, it, expect } from 'vitest'
import { SubShapeDedup, SubShapeIndexMap } from './primitives'
import type { OccSubShape } from './occTypes'

// A stub sub-shape: `_id` is its identity, `hash` lets a test force collisions.
// `SubShapeDedup` calls `u.IsSame(shape)` with the full stub, so identity must
// be readable off the passed object, not off a closure.
function stub(id: number, hash: number): OccSubShape {
  const s = {
    _id: id,
    HashCode: () => hash,
    IsSame: (o: { _id: number }) => o._id === id,
    delete: () => {},
    IsPartner: () => false,
    Located: () => s as unknown as never,
  }
  return s as unknown as OccSubShape
}

describe('SubShapeDedup', () => {
  it('adds each distinct identity once and reports duplicates as seen', () => {
    const d = new SubShapeDedup()
    const a = stub(1, 10)
    const b = stub(2, 20)
    expect(d.add(a)).toBe(true)
    expect(d.add(b)).toBe(true)
    expect(d.add(stub(1, 10))).toBe(false)  // same identity, different handle
  })

  it('keeps distinct identities even under a forced hash collision', () => {
    const d = new SubShapeDedup()
    expect(d.add(stub(1, 7))).toBe(true)
    expect(d.add(stub(2, 7))).toBe(true)  // bucket collision, but IsSame says distinct
    expect(d.add(stub(1, 7))).toBe(false)  // confirms against the right twin in the bucket
    expect(d.add(stub(2, 7))).toBe(false)
  })
})

describe('SubShapeIndexMap', () => {
  it('returns 1:1 the first index registered per identity (first-wins)', () => {
    const m = new SubShapeIndexMap()
    const a = stub(1, 10)
    const b = stub(2, 20)
    m.set(a, 0)
    m.set(b, 1)
    m.set(stub(1, 10), 99)  // duplicate identity must never win a later index
    expect(m.get(a)).toBe(0)
    expect(m.get(b)).toBe(1)
    expect(m.get(stub(1, 10))).toBe(0)
    expect(m.get(stub(3, 30))).toBe(-1)
  })

  it('resolves lookups correctly through a hash-collision bucket', () => {
    const m = new SubShapeIndexMap()
    m.set(stub(1, 7), 0)
    m.set(stub(2, 7), 1)
    expect(m.get(stub(1, 7))).toBe(0)
    expect(m.get(stub(2, 7))).toBe(1)
  })
})
