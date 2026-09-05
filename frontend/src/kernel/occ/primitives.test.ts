// @vitest-environment node
//
// Unit tests for the hash-bucketed dedup helpers that replaced the old O(n^2)
// `some(IsSame)` accumulating-list scans. No OCC needed: stub shapes carry just
// the two methods `SubShapeDedup`/`SubShapeIndexMap` touch, so the semantics of
// the routing (first-wins, identical-dedup, distinct-kept, hash-collision-safe)
// are pinned without a WASM build.

import { describe, it, expect } from 'vitest'
import { SubShapeDedup, SubShapeIndexMap, SubShapeMultiIndex, makeEllipseEdge } from './primitives'
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

  it('has answers membership without registering the query (read-only test)', () => {
    // booleanWithHistory pre-seeds a dedup from the inherited pool, then asks
    // "is this output shape in the pool?" for every output. `add` would be a
    // membership test only while the query set never grows; `has` must not
    // register a new shape, or the second explorer occurrence of a shared new
    // edge would read as inherited and halve every new_edges count.
    const d = new SubShapeDedup()
    d.add(stub(1, 10))
    expect(d.has(stub(1, 10))).toBe(true)
    expect(d.has(stub(2, 20))).toBe(false)
    expect(d.has(stub(2, 20))).toBe(false)  // still absent: the query was not registered
    expect(d.has(stub(3, 30))).toBe(false)
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

describe('SubShapeMultiIndex', () => {
  it('returns every value registered per identity, in insertion order', () => {
    const m = new SubShapeMultiIndex<number>()
    const a = stub(1, 10)
    m.add(a, 0)
    m.add(stub(2, 20), 1)
    m.add(stub(1, 10), 2)
    m.add(a, 3)
    // Insertion order is load-bearing: Change 4b's `find(!fromTool) ?? matches[0]`
    // tie-break relies on target-before-tool ordering surviving the index.
    expect(m.get(stub(1, 10))).toEqual([0, 2, 3])
    expect(m.get(stub(2, 20))).toEqual([1])
  })

  it('returns [] for an unknown identity', () => {
    const m = new SubShapeMultiIndex<string>()
    m.add(stub(1, 10), 'a')
    expect(m.get(stub(3, 30))).toEqual([])
  })

  it('preserves target-before-tool order for the find(!fromTool) tie-break', () => {
    // The whole naming outcome of a fuse hangs on this: collectPairs runs the
    // target first, so for an output face that both a target and a tool input
    // reached, the target pair must sit before the tool pair in the bucket.
    const m = new SubShapeMultiIndex<{ fromTool: boolean }>()
    const out = stub(1, 10)
    m.add(out, { fromTool: false })  // target pair first, exactly as collectPairs
    m.add(out, { fromTool: true })   // tool pair second
    const matches = m.get(stub(1, 10))
    expect(matches.find((p) => !p.fromTool) ?? matches[0]).toEqual({ fromTool: false })
    // A tool-only output still picks the first tool pair, not undefined.
    const out2 = stub(2, 20)
    m.add(out2, { fromTool: true })
    m.add(out2, { fromTool: true })
    const m2 = m.get(stub(2, 20))
    expect(m2.find((p) => !p.fromTool) ?? m2[0]).toEqual({ fromTool: true })
  })

  it('keeps identities distinct inside one HashCode-collision bucket', () => {
    const m = new SubShapeMultiIndex<number>()
    m.add(stub(1, 7), 10)
    m.add(stub(2, 7), 20)  // bucket collision, but IsSame says distinct
    m.add(stub(2, 7), 21)
    expect(m.get(stub(1, 7))).toEqual([10])
    expect(m.get(stub(2, 7))).toEqual([20, 21])
  })
})

describe('makeEllipseEdge radius validation', () => {
  // The guard runs before any OCC object is built, so a stub oc is enough to
  // prove the refusal (no WASM build needed for B2).
  const stub = ({} as never)

  it('refuses a minor radius larger than the major (b > a) by name', () => {
    expect(() =>
      makeEllipseEdge(stub, stub, [0, 0, 0], [0, 0, 1], [1, 0, 0], 2, 3),
    ).toThrow(/make_ellipse_edge: needs a >= b > 0 \(got a=2, b=3\)/)
  })

  it('refuses a non-positive major radius', () => {
    expect(() =>
      makeEllipseEdge(stub, stub, [0, 0, 0], [0, 0, 1], [1, 0, 0], 0, 2),
    ).toThrow(/make_ellipse_edge: needs a >= b > 0 \(got a=0, b=2\)/)
  })

  it('refuses a non-positive minor radius', () => {
    expect(() =>
      makeEllipseEdge(stub, stub, [0, 0, 0], [0, 0, 1], [1, 0, 0], 2, 0),
    ).toThrow(/make_ellipse_edge: needs a >= b > 0 \(got a=2, b=0\)/)
  })

  it('accepts a >= b > 0 (the validation does not fire)', () => {
    expect(() =>
      makeEllipseEdge(stub, stub, [0, 0, 0], [0, 0, 1], [1, 0, 0], 4, 2),
    ).not.toThrow(/make_ellipse_edge: needs/)
  })
})
