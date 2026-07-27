import { describe, it, expect } from 'vitest'
import { applyAddDeleteBody, applyAddDeleteBodyRef, applyRemoveDeleteBodyRef } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'

function emptyDoc(): PartDoc { return { features: [] } }

describe('applyAddDeleteBody', () => {
  it('adds a delete_body feature', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1', ['@body_ex1', '@body_ex2'])
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('delete_body')
    expect(doc.features![0].delete_body?.bodies).toEqual(['@body_ex1', '@body_ex2'])
  })

  it('defaults to an empty body list when none given', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1')
    expect(doc.features![0].delete_body?.bodies).toEqual([])
  })

  it('copies the given list so the caller cannot alias the doc', () => {
    const doc = emptyDoc()
    const bodies = ['@body_ex1']
    applyAddDeleteBody(doc, 'db1', bodies)
    bodies.push('@body_ex2')
    expect(doc.features![0].delete_body?.bodies).toEqual(['@body_ex1'])
  })

  it('uses default label', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1')
    expect(doc.features![0].label).toBe('Delete Body')
  })
})

describe('applyAddDeleteBodyRef', () => {
  it('appends picks in order', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1')
    applyAddDeleteBodyRef(doc, 'db1', '@body_ex1')
    applyAddDeleteBodyRef(doc, 'db1', '@body_ex2')
    expect(doc.features![0].delete_body?.bodies).toEqual(['@body_ex1', '@body_ex2'])
  })

  it('toggles an already-picked body back out', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1', ['@body_ex1', '@body_ex2'])
    applyAddDeleteBodyRef(doc, 'db1', '@body_ex1')
    expect(doc.features![0].delete_body?.bodies).toEqual(['@body_ex2'])
  })

  it('ignores unknown featureId', () => {
    const doc = emptyDoc()
    expect(() => applyAddDeleteBodyRef(doc, 'nope', '@body_ex1')).not.toThrow()
  })
})

describe('applyRemoveDeleteBodyRef', () => {
  it('removes the entry at the given index', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1', ['@body_ex1', '@body_ex2', '@body_ex3'])
    applyRemoveDeleteBodyRef(doc, 'db1', 1)
    expect(doc.features![0].delete_body?.bodies).toEqual(['@body_ex1', '@body_ex3'])
  })

  it('ignores unknown featureId', () => {
    const doc = emptyDoc()
    expect(() => applyRemoveDeleteBodyRef(doc, 'nope', 0)).not.toThrow()
  })
})
