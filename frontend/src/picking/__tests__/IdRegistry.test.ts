import { describe, it, expect, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'

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

  it('treats (layer, key) as the composite identity', () => {
    const a = reg.allocate('face', 'shared')
    const b = reg.allocate('edge', 'shared')
    expect(a).not.toBe(b)
  })

  it('lookup returns the original record', () => {
    const id = reg.allocate('face', 'face@e1#1')
    const rec = reg.lookup(id)
    expect(rec).toEqual({ id, layer: 'face', entityKey: 'face@e1#1' })
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
})
