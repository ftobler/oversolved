import { describe, it, expect } from 'vitest'
import { bodyIdOfPick } from '@/utils/query/bodyIdOfPick'
import { makeAncestryQuery } from '@/kernel/queryWire'

const bodies = {
  body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [] },
  body_ex1_1: { id: 'body_ex1_1', created_by: 'ex1', modified_by: [] },
  body_ex2: { id: 'body_ex2', created_by: 'ex2', modified_by: [] },
} as Record<string, { id: string; created_by: string; modified_by: string[] }>

describe('bodyIdOfPick', () => {
  it('exact id', () => {
    expect(bodyIdOfPick('body_ex2', bodies)).toBe('body_ex2')
  })
  it('topo fallback', () => {
    expect(bodyIdOfPick('@body_ex1_1/face/0', bodies)).toBe('body_ex1_1')
  })
  it('face ? ancestry made by sketch', () => {
    // need body ancestor
    const b = { body_ex1: { id: 'body_ex1', created_by: 'ex1', modified_by: [] } } as Record<string, { id: string; created_by: string; modified_by: string[] }>
    // construct a query with @body_ex1 ancestor
    const q2 = '?9;@body_ex1:face'
    // not exact parse? just ensure null-safe
    expect(bodyIdOfPick(q2, b)).toBe('body_ex1')
  })
  it('boolean first @body ancestor wins', () => {
    const q = makeAncestryQuery(['@body_a', '@body_b'], 'face')
    const b = {
      body_a: { id: 'body_a', created_by: 'a', modified_by: [] },
      body_b: { id: 'body_b', created_by: 'b', modified_by: [] },
    } as Record<string, { id: string; created_by: string; modified_by: string[] }>
    expect(bodyIdOfPick(q, b)).toBe('body_a')
  })
  it('split sibling', () => {
    expect(bodyIdOfPick('body_ex1_1', bodies)).toBe('body_ex1_1')
  })
  it('bare feature one body', () => {
    const b = { body_ex2: { id: 'body_ex2', created_by: 'ex2', modified_by: [] } } as Record<string, { id: string; created_by: string; modified_by: string[] }>
    expect(bodyIdOfPick('@ex2', b)).toBe('body_ex2')
  })
  it('bare feature two bodies returns null', () => {
    expect(bodyIdOfPick('@ex1', bodies)).toBeNull()
  })
  it('stale ref returns null', () => {
    expect(bodyIdOfPick('@nope', bodies)).toBeNull()
    expect(bodyIdOfPick('body_nope', bodies)).toBeNull()
  })
})
