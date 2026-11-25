// A mate reference names a part instance, but the instance carries no name of
// its own: the name lives in the workspace document. Two placements of one part
// document therefore need a render ordinal so the chips and the tree can tell
// them apart, without writing that ordinal into the document.

import { describe, it, expect } from 'vitest'
import type { PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { instanceLabel } from '@/utils/instanceLabel'

function instance(handle: string, docId: string): PartInstance {
  return {
    handle,
    doc_id: docId,
    doc_rev: 0,
    transform: { ...IDENTITY_TRANSFORM },
    visible: true,
  }
}

describe('instanceLabel', () => {
  it('names a lone instance by its part document', () => {
    expect(instanceLabel([instance('h1', 'doc-x')], { 'doc-x': 'Bracket' }, 'h1')).toBe('Bracket')
  })

  it('numbers instances sharing a document in authored order', () => {
    const instances = [instance('h1', 'doc-x'), instance('h2', 'doc-x')]
    const names = { 'doc-x': 'X' }
    expect(instanceLabel(instances, names, 'h1')).toBe('X')
    expect(instanceLabel(instances, names, 'h2')).toBe('X (2)')
  })

  it('follows the current authored order when a middle instance is deleted', () => {
    // The ordinal is a view of the instances still in the document, never a
    // persisted index: deleting the first of three must not renumber the rest
    // into a gap ("X", "X (3)").
    const instances = [instance('h1', 'doc-x'), instance('h3', 'doc-x')]
    const names = { 'doc-x': 'X' }
    expect(instanceLabel(instances, names, 'h1')).toBe('X')
    expect(instanceLabel(instances, names, 'h3')).toBe('X (2)')
  })

  it('gives no ordinal to instances of different documents', () => {
    const instances = [instance('h1', 'doc-x'), instance('h2', 'doc-y')]
    const names = { 'doc-x': 'Bracket', 'doc-y': 'Plate' }
    expect(instanceLabel(instances, names, 'h1')).toBe('Bracket')
    expect(instanceLabel(instances, names, 'h2')).toBe('Plate')
  })

  it('only counts top-level instances of the same document', () => {
    const instances = [
      instance('h1', 'doc-x'), instance('h2', 'doc-y'), instance('h3', 'doc-x'),
    ]
    const names = { 'doc-x': 'X', 'doc-y': 'Y' }
    expect(instanceLabel(instances, names, 'h2')).toBe('Y')
    expect(instanceLabel(instances, names, 'h3')).toBe('X (2)')
  })

  it('falls back to the doc id when the workspace has no name for it', () => {
    expect(instanceLabel([instance('h1', 'doc-x')], {}, 'h1')).toBe('doc-x')
  })

  it('returns undefined for a handle the document no longer holds', () => {
    expect(instanceLabel([], {}, 'missing')).toBeUndefined()
  })
})
