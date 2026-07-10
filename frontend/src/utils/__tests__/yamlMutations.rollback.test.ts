import { describe, it, expect } from 'vitest'
import { applySetRollback } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ],
  } as PartDoc
}

describe('applySetRollback', () => {
  it('stores a position that rolls the stack back', () => {
    const doc = makeDoc()
    applySetRollback(doc, 2)
    expect(doc.rollback).toBe(2)
  })

  it('writes absence rather than features.length for a bar at the end', () => {
    const doc = makeDoc()
    applySetRollback(doc, 3)
    expect('rollback' in doc).toBe(false)
  })

  it('writes absence for null (end of stack)', () => {
    const doc = makeDoc()
    applySetRollback(doc, null)
    expect('rollback' in doc).toBe(false)
  })

  it('clears a previously stored position when the bar returns to the end', () => {
    const doc = makeDoc()
    doc.rollback = 1
    applySetRollback(doc, null)
    expect('rollback' in doc).toBe(false)
  })

  it('clears a stored position that a longer stack has left behind', () => {
    const doc = makeDoc()
    doc.rollback = 1
    applySetRollback(doc, 5)
    expect('rollback' in doc).toBe(false)
  })

  it('clamps a negative position to zero', () => {
    const doc = makeDoc()
    applySetRollback(doc, -1)
    expect(doc.rollback).toBe(0)
  })

  it('treats an empty doc as having no room to roll back', () => {
    const doc: PartDoc = { version: 1, kind: 'part' }
    applySetRollback(doc, 0)
    expect('rollback' in doc).toBe(false)
  })
})
