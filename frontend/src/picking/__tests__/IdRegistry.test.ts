import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { MAX_ID } from '../idEncoding'

describe('IdRegistry', () => {
  let reg: IdRegistry
  beforeEach(() => { reg = new IdRegistry() })

  it('allocates distinct ids for distinct keys', () => {
    const a = reg.allocate('face', 'face@e1#1')
    const b = reg.allocate('face', 'face@e1#2')
    const c = reg.allocate('edge', 'edge@e1#1')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })

  it('returns the same id for repeated allocation of the same key', () => {
    const a = reg.allocate('face', 'face@e1#1')
    const a2 = reg.allocate('face', 'face@e1#1')
    expect(a).toBe(a2)
  })

  it('gives distinct ids to primitives that share a query but differ in pickKey', () => {
    // Regression lock: two edges with a colliding query string (no minted UUID,
    // same octant) must not collapse onto one ID. The per-primitive pickKey
    // keeps them distinct while both records still carry the shared query.
    const a = reg.allocate('edge', 'edge@dup', 'feat/body#0')
    const b = reg.allocate('edge', 'edge@dup', 'feat/body#1')
    expect(a).not.toBe(b)
    expect(reg.lookup(a)!.entityKey).toBe('edge@dup')
    expect(reg.lookup(b)!.entityKey).toBe('edge@dup')
    expect(reg.lookup(a)!.pickKey).toBe('feat/body#0')
    expect(reg.lookup(b)!.pickKey).toBe('feat/body#1')
  })

  it('treats (layer, key) as the composite identity', () => {
    const a = reg.allocate('face', 'shared')
    const b = reg.allocate('edge', 'shared')
    expect(a).not.toBe(b)
  })

  it('lookup returns the original record', () => {
    const id = reg.allocate('face', 'face@e1#1')
    const rec = reg.lookup(id)
    expect(rec).toEqual({ id, layer: 'face', entityKey: 'face@e1#1', pickKey: 'face@e1#1' })
  })

  it('lookupKey round-trips', () => {
    const id = reg.allocate('face', 'face@e1#1')
    expect(reg.lookupKey('face', 'face@e1#1')).toBe(id)
    expect(reg.lookupKey('face', 'missing')).toBeUndefined()
  })

  it('free does NOT immediately reuse the id; bumpCycle promotes the slot', () => {
    const a = reg.allocate('face', 'face@e1#1')
    reg.free(a)
    // Without bumpCycle, a fresh alloc must NOT recycle a.
    const b = reg.allocate('face', 'face@e1#2')
    expect(b).not.toBe(a)
    // After bumpCycle, the freed slot is eligible.
    reg.bumpCycle()
    const c = reg.allocate('face', 'face@e1#3')
    expect(c).toBe(a)
  })

  it('recycles freed ids without bumpCycle once enough have piled up', () => {
    // A canvas that stops rendering never calls bumpCycle. Reclamation must not
    // stall: repeated free/allocate with no bump has to recycle ids rather than
    // march nextId toward MAX_ID. Once the deferred set reaches its bound, free()
    // promotes it itself.
    const seen = new Set<number>()
    for (let i = 0; i < 8000; i++) {
      const id = reg.allocate('face', `face@e1#${i}`)
      seen.add(id)
      reg.free(id)
    }
    // With no reclamation this would climb to ~8000; the self-promotion keeps
    // both the id ceiling and the distinct-id count well under it.
    expect(Math.max(...seen)).toBeLessThan(2500)
    expect(seen.size).toBeLessThan(2500)
  })

  it('lookup stays valid after free until bumpCycle (so async readbacks decode)', () => {
    const id = reg.allocate('face', 'face@e1#1')
    reg.free(id)
    // lookupKey drops immediately so a re-allocation gets a fresh id...
    expect(reg.lookupKey('face', 'face@e1#1')).toBeUndefined()
    // ...but the id is still resolvable until bumpCycle.
    expect(reg.lookup(id)).toBeDefined()
    reg.bumpCycle()
    expect(reg.lookup(id)).toBeUndefined()
  })

  it('size tracks live entries only', () => {
    const a = reg.allocate('face', 'face@e1#1')
    reg.allocate('face', 'face@e1#2')
    expect(reg.size()).toBe(2)
    reg.free(a)
    expect(reg.size()).toBe(1)
  })

  it('clear resets all state', () => {
    reg.allocate('face', 'face@e1#1')
    reg.clear()
    expect(reg.size()).toBe(0)
    expect(reg.lookupKey('face', 'face@e1#1')).toBeUndefined()
  })

  it('throws rather than wrap when the 24-bit id space is exhausted', () => {
    // The viewport has no error boundary above the registration effects, so this
    // throw is the only thing that stops a silently reused ID. Every ID-layer
    // register path is written to let it escape and be contained per hook.
    ;(reg as unknown as { nextId: number }).nextId = MAX_ID + 1
    expect(() => reg.allocate('face', 'face@e1#1')).toThrow(/exhausted 24-bit ID space/)
  })

  it('freeing an id that was never allocated is a no-op', () => {
    // Body teardown can outlive its allocation (a failed mid-pass register frees
    // what it took); a double free must not touch the live entries.
    const live = reg.allocate('face', 'face@e1#1')
    expect(() => reg.free(424242)).not.toThrow()
    expect(reg.lookup(live)).toBeDefined()
    expect(reg.size()).toBe(1)
  })
})
