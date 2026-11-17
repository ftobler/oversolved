import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeatureEditor, type FeatureEditorSchema } from '@/components/editors/FeatureEditor'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { unitLabel, type Quantity } from '@/utils/fieldUnit'
import type { PartFeature } from '@/types/cad'

const QUANTITIES: readonly Quantity[] = ['length', 'angle', 'count', 'turns', 'none']
const UNIT_SUFFIX = /\((deg|mm|in|pcs|°)\)\s*$/

function numericFields() {
  const rows: { kind: string; index: number; key: string; label: string; field: Record<string, unknown> }[] = []
  for (const [kind, schema] of Object.entries(EDITOR_SCHEMAS)) {
    schema.fields.forEach((field, index) => {
      if (field.type !== 'number' && field.type !== 'readonly') return
      rows.push({ kind, index, key: field.key, label: field.label, field: field as unknown as Record<string, unknown> })
    })
  }
  return rows
}

describe('every feature schema number field', () => {
  it('names a known quantity, the field itself in the failure', () => {
    // The type already requires `quantity`; this catches a schema assembled
    // without the compiler (a JS fixture) and a new quantity nobody taught the
    // resolver. The failure names the row, so the fix is obvious.
    const bad = numericFields()
      .filter(({ field }) => !QUANTITIES.includes(field.quantity as Quantity))
      .map(({ kind, index, key, label }) => `${kind} field ${index} '${key}' (${label})`)
    expect(bad).toEqual([])
  })

  it('keeps unit suffixes out of every label', () => {
    const bad: string[] = []
    for (const [kind, schema] of Object.entries(EDITOR_SCHEMAS)) {
      schema.fields.forEach((field, index) => {
        if (UNIT_SUFFIX.test(field.label)) bad.push(`${kind} field ${index} '${field.key}' (${field.label})`)
      })
    }
    expect(bad).toEqual([])
  })

  it('resolves one label per quantity, so no field is silently unitless', () => {
    const lengthCount = numericFields().filter(({ field }) => field.quantity === 'length').length
    expect(lengthCount).toBeGreaterThan(20)
    expect(unitLabel('length', 'mm')).toBe('mm')
  })

  it('states a helix turn as its own kind, not as a count', () => {
    // A turn is a revolution, not a piece: 'pcs' would state a different thing.
    const turns = EDITOR_SCHEMAS.helix.fields.find((field) => field.key === 'turns')
    expect((turns as { quantity?: Quantity } | undefined)?.quantity).toBe('turns')
    expect(unitLabel('turns', 'mm')).toBe('rev')
  })

  it('treats a manual pattern step as a per-step length', () => {
    // kernel/features/linearPattern.ts `resolveLinearStep` manual mode returns
    // the stored triple as the step vector itself, magnitude included, so each
    // component is a displacement in the document's unit.
    const steps = EDITOR_SCHEMAS.linear_pattern.fields.filter((field) => field.key === 'direction')
    expect(steps.map((field) => (field as { quantity?: Quantity }).quantity)).toEqual(['length', 'length', 'length'])
  })
})

describe('a length field in an inch document', () => {
  it('renders in without touching the stored value', () => {
    const schema: FeatureEditorSchema = {
      mutationPrefix: 'set_test',
      subKey: 'test',
      defaults: { diam: 10 },
      fields: [{ type: 'number', key: 'diam', label: 'Diameter', default: 10, quantity: 'length' }],
    }
    const feature = { id: 'f1', kind: 'test', test: { diam: 0.5 } } as unknown as PartFeature
    render(<FeatureEditor feature={feature} onMutation={() => undefined} schema={schema} lengthUnit="inch" />)
    expect(screen.getByDisplayValue('0.5')).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
    expect(screen.queryByText('mm')).not.toBeInTheDocument()
  })
})
