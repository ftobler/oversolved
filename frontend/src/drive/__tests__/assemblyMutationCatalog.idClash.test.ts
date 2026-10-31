// A feature id is unique across the whole assembly: a mate may not take the id
// add_part derives for an instance, nor a builtin's id.
import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { validateAssemblyMutation } from '../assemblyMutationCatalog'

const T = { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
const doc: AssemblyDoc = {
  kind: 'assembly',
  features: [
    { id: 'AssemblyTop', kind: 'plane' },
    { id: 'inst_plate', kind: 'part_instance', instance: { handle: 'plate', doc_id: 'p', doc_rev: 0, transform: T } },
    { id: 'inst_blk', kind: 'part_instance', instance: { handle: 'blk', doc_id: 'p', doc_rev: 0, transform: T } },
    { id: 'inst_pin', kind: 'mate', mate: { kind: 'fixed', ref_a: { part: 'plate', anchor: 'a' }, ref_b: { part: 'plate', anchor: 'b' } } },
  ],
}
const ctx = {
  doc,
  boundPartIds: new Set(['p']) as ReadonlySet<string>,
  resolveRef: (ref: { part: string }) => ({ ok: true as const, ref: { part: ref.part, anchor: 'a' } }),
}
const mate = (featureId: string) => ({
  type: 'add_mate', featureId, kind: 'fixed',
  ref_a: { part: 'plate', anchor: 'a' }, ref_b: { part: 'blk', anchor: 'b' },
})

describe('feature id clashes', () => {
  it.each(['inst_plate', 'AssemblyTop'])('refuses add_mate with the existing id %s', (id) => {
    const result = validateAssemblyMutation(mate(id), ctx)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toContain('already names a feature')
  })

  it('refuses add_part whose derived inst_ id names a mate', () => {
    const result = validateAssemblyMutation({ type: 'add_part', handle: 'pin', part: 'p' }, ctx)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toContain('inst_pin')
  })

  it('refuses duplicate_part whose derived inst_ id names a mate', () => {
    const result = validateAssemblyMutation({ type: 'duplicate_part', handle: 'plate', newHandle: 'pin' }, ctx)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toContain('inst_pin')
  })

  it('accepts a fresh id', () => {
    expect(validateAssemblyMutation(mate('m_fresh'), ctx).ok).toBe(true)
  })
})
