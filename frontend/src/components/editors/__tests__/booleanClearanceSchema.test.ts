// The Clearance field of the boolean editor schema: shown for subtract only, a
// mm number defaulting to 0. Switching the operation to union/intersect must
// hide it (the value stays in the doc; the solver ignores it with a warning).
import { describe, it, expect } from 'vitest'
import { BOOLEAN_SCHEMA } from '../featureEditorSchemas'

type LooseField = {
  key: string
  type: string
  label?: string
  default?: unknown
  unit?: string
  showWhen?: (data: Record<string, unknown>) => boolean
}

const field = BOOLEAN_SCHEMA.fields.find((f) => (f as LooseField).key === 'clearance') as LooseField | undefined

describe('BOOLEAN_SCHEMA clearance field', () => {
  it('is a number field labelled Clearance in mm, defaulting to 0', () => {
    expect(field).toBeDefined()
    expect(field?.type).toBe('number')
    expect(field?.label).toBe('Clearance')
    expect(field?.unit).toBe('mm')
    expect(field?.default).toBe(0)
  })

  it('is shown for subtract and hidden for union/intersect', () => {
    expect(field?.showWhen?.({ operation: 'subtract' })).toBe(true)
    expect(field?.showWhen?.({ operation: 'union' })).toBe(false)
    expect(field?.showWhen?.({ operation: 'intersect' })).toBe(false)
  })
})
