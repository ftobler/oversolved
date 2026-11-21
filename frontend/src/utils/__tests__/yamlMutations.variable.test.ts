import { describe, it, expect } from 'vitest'
import { applyAddVariable, applySetVariableField, applyRenameFeature } from '@/utils/yamlMutations'
import { MutationRefusal } from '@/utils/yamlMutations/helpers'
import type { PartDoc } from '@/types/cad'
import { featureAt } from '@/testing/featureAccess'

function emptyDoc(): PartDoc {
  return { features: [] }
}

function refusalOf(run: () => void): MutationRefusal {
  try {
    run()
  } catch (e) {
    if (e instanceof MutationRefusal) return e
    throw e
  }
  throw new Error('expected a MutationRefusal')
}

describe('applyAddVariable', () => {
  it('creates a variable feature with the numeric default expression and label', () => {
    // The number field stores a plain number; seeding the old text "0" would
    // make a fresh add differ from the field's own first commit.
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1')
    expect(doc.features).toEqual([
      { id: 'v1', kind: 'variable', label: 'var', variable: { expression: 0 } },
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
    expect(featureAt(doc, 0, 'variable').variable.expression).toBe('100 + margin')
  })

  it('sets the unit', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applySetVariableField(doc, 'v1', 'unit', 'mm')
    expect(featureAt(doc, 0, 'variable').variable.unit).toBe('mm')
  })

  it('no-ops on a feature without a variable sub-dict', () => {
    const doc: PartDoc = { features: [{ id: 'x', kind: 'extrude', extrude: { sketch: [], distance: 1 } }] }
    applySetVariableField(doc, 'x', 'expression', '5')
    expect(doc.features?.[0]).toEqual({ id: 'x', kind: 'extrude', extrude: { sketch: [], distance: 1 } })
  })
})

describe('applyRenameFeature variable guard', () => {
  it('renames a variable to a valid identifier', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applyRenameFeature(doc, 'v1', 'height')
    expect(doc.features?.[0].label).toBe('height')
  })

  it('accepts an underscore name', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applyRenameFeature(doc, 'v1', '_w')
    expect(doc.features?.[0].label).toBe('_w')
  })

  it('throws the shared sentence for an invalid identifier and keeps the old label', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    const refusal = refusalOf(() => applyRenameFeature(doc, 'v1', 'my-var'))
    expect(refusal.message).toBe(
      '"my-var" is not a valid variable name: use letters, digits and _ only '
        + '(a - reads as minus in an expression). Try "my_var".',
    )
    expect(doc.features?.[0].label).toBe('width')
  })

  it('throws for a reserved constant and keeps the old label', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    const refusal = refusalOf(() => applyRenameFeature(doc, 'v1', 'pi'))
    expect(refusal.message).toBe('"pi" is a built-in constant and cannot name a variable.')
    expect(doc.features?.[0].label).toBe('width')
  })

  it('throws for a colliding rename and keeps the old label', () => {
    const doc = emptyDoc()
    applyAddVariable(doc, 'v1', 'width')
    applyAddVariable(doc, 'v2', 'height')
    const refusal = refusalOf(() => applyRenameFeature(doc, 'v2', 'width'))
    expect(refusal.message).toBe('A variable named "width" already exists.')
    expect(doc.features?.[1].label).toBe('height')
  })

  it('still allows duplicate labels on non-variable features', () => {
    const doc: PartDoc = { features: [{ id: 's1', kind: 'sketch', label: 'sketch 1' }] }
    applyRenameFeature(doc, 's1', 'sketch 2')
    expect(doc.features?.[0].label).toBe('sketch 2')
  })

  it('still accepts a hyphen in a non-variable label, the audit guard', () => {
    const doc: PartDoc = { features: [{ id: 's1', kind: 'sketch', label: 'sketch 1' }] }
    applyRenameFeature(doc, 's1', 'my-feature')
    expect(doc.features?.[0].label).toBe('my-feature')
  })
})
