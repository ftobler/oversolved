// E-13: add_mate and set_mate_ref keep the resolver's own refusal code, so a
// caller can tell a misspelled instance handle (unknown-target) from a query
// the part build no longer carries (unresolved-ref).

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import type { PartAnchorIndex } from '../assemblyRefs'
import { resolveDriveRef } from '../assemblyRefs'
import { validateAssemblyMutation } from '../assemblyMutationCatalog'

const T = { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

const doc: AssemblyDoc = {
  kind: 'assembly',
  features: [
    { id: 'AssemblyTop', kind: 'plane' },
    { id: 'inst_plate', kind: 'part_instance', instance: { handle: 'plate', doc_id: 'p', doc_rev: 0, transform: T } },
    { id: 'inst_pin', kind: 'part_instance', instance: { handle: 'pin', doc_id: 'p', doc_rev: 0, transform: T } },
    {
      id: 'm1',
      kind: 'mate',
      mate: { kind: 'fixed', ref_a: { part: 'plate', anchor: 'a' }, ref_b: { part: 'pin', anchor: 'b' } },
    },
  ],
}

// A built part whose index carries no queries: an anchor id would resolve, a
// query is stale.
const index: PartAnchorIndex = { anchors: {}, byQuery: new Map(), bodies: {} }

const ctx = {
  doc,
  boundPartIds: new Set(['p']) as ReadonlySet<string>,
  resolveRef: (ref: Parameters<typeof resolveDriveRef>[0]) => resolveDriveRef(ref, doc, () => index),
}

describe('mate ref refusal codes', () => {
  it('add_mate names a misspelled handle as unknown-target', () => {
    const result = validateAssemblyMutation({
      type: 'add_mate',
      featureId: 'm2',
      kind: 'fixed',
      ref_a: { part: 'pltae', query: '?q' },
      ref_b: { part: 'pin', query: '?q' },
    }, ctx)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('unknown-target')
    expect(!result.ok && result.error.message).toContain('instances: plate, pin')
  })

  it('add_mate keeps a stale query as unresolved-ref', () => {
    const result = validateAssemblyMutation({
      type: 'add_mate',
      featureId: 'm2',
      kind: 'fixed',
      ref_a: { part: 'plate', query: '?gone' },
      ref_b: { part: 'pin', query: '?q' },
    }, ctx)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('unresolved-ref')
    expect(!result.ok && result.error.message).toContain('query not found')
  })

  it('a malformed ref shape is invalid-ref, not a failed match', () => {
    const result = validateAssemblyMutation({
      type: 'add_mate',
      featureId: 'm2',
      kind: 'fixed',
      ref_a: { part: 'plate' },
      ref_b: { part: 'pin', query: '?q' },
    }, ctx)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('invalid-ref')
    expect(!result.ok && result.error.message).toContain('exactly one of query, selector or anchor')
  })

  it('set_mate_ref keeps unknown-target too', () => {
    const result = validateAssemblyMutation({
      type: 'set_mate_ref',
      featureId: 'm1',
      field: 'ref_b',
      ref: { part: 'nope', query: '?q' },
    }, ctx)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('unknown-target')
  })
})
