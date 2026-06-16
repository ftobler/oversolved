import { describe, it, expect } from 'vitest'
import { applyAddVariable, applySetVariableField, applyRenameFeature } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'

function emptyDoc(): PartDoc {
  return { features: [] }
}

describe('applyAddVariable', () => {
  it('creates a variable feature with default expression and label', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1')
    expect(doc.features).toEqual([
      { id: 'v1', kind: 'variable', label: 'var', variable: { expression: '0' } },
    ])
  })

  it('uses the provided label when valid', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    expect(doc.features?.[0].label).toBe('width')
  })

  it('sanitizes spaces and leading digits', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'my var')
    expect(doc.features?.[0].label).toBe('my_var')
    applyAddVariable(doc, 'v2', '1var')
    expect(doc.features?.[1].label).toBe('var_1var')
  })

  it('auto-increments on label collision', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applyAddVariable(doc, 'v2', 'width')
    applyAddVariable(doc, 'v3', 'width')
    expect(doc.features?.map(f => f.label)).toEqual(['width', 'width_2', 'width_3'])
  })

  it('falls back to var on total sanitization', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', '!!!')
    expect(doc.features?.[0].label).toBe('var')
  })
})

describe('applySetVariableField', () => {
  it('sets the expression', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applySetVariableField(doc, 'v1', 'expression', '100 + margin')
    expect(doc.features?.[0].variable?.expression).toBe('100 + margin')
  })

  it('sets the unit', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applySetVariableField(doc, 'v1', 'unit', 'mm')
    expect(doc.features?.[0].variable?.unit).toBe('mm')
  })

  it('no-ops on a feature without a variable sub-dict', () => {
    const doc: PartDoc = { features: [{ id: 'x', kind: 'extrude' }] }
    applySetVariableField(doc, 'x', 'expression', '5')
    expect(doc.features?.[0]).toEqual({ id: 'x', kind: 'extrude' })
  })
})

describe('applyRenameFeature variable guard', () => {
  it('renames a variable to a valid identifier', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applyRenameFeature(doc, 'v1', 'height')
    expect(doc.features?.[0].label).toBe('height')
  })

  it('rejects an invalid identifier rename', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applyRenameFeature(doc, 'v1', 'my var')
    expect(doc.features?.[0].label).toBe('width')
  })

  it('rejects a colliding rename', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applyAddVariable(doc, 'v2', 'height')
    applyRenameFeature(doc, 'v2', 'width')
    expect(doc.features?.[1].label).toBe('height')
  })

  it('still allows duplicate labels on non-variable features', () => {
    const doc: PartDoc = { features: [{ id: 's1', kind: 'sketch', label: 'sketch 1' }] }
    applyRenameFeature(doc, 's1', 'sketch 2')
    expect(doc.features?.[0].label).toBe('sketch 2')
  })
})
