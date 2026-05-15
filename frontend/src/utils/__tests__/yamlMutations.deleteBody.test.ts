import { describe, it, expect } from 'vitest'
import { applyAddDeleteBody, applySetDeleteBodyTarget } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'

function emptyDoc(): PartDoc { return { features: [] } }

describe('applyAddDeleteBody', () => {
  it('adds a delete_body feature', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1', '@body_ex1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('delete_body')
    expect(doc.features![0].delete_body?.body).toBe('@body_ex1')
  })

  it('defaults to empty body when none given', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1')
    expect(doc.features![0].delete_body?.body).toBe('')
  })

  it('uses default label', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1')
    expect(doc.features![0].label).toBe('Delete Body')
  })
})

describe('applySetDeleteBodyTarget', () => {
  it('updates the body query', () => {
    const doc = emptyDoc()
    applyAddDeleteBody(doc, 'db1')
    applySetDeleteBodyTarget(doc, 'db1', '@body_ex2')
    expect(doc.features![0].delete_body?.body).toBe('@body_ex2')
  })

  it('ignores unknown featureId', () => {
    const doc = emptyDoc()
    expect(() => applySetDeleteBodyTarget(doc, 'nope', '@body_ex1')).not.toThrow()
  })
})
