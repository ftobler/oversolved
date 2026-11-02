import { describe, it, expect } from 'vitest'
import { loadPartDoc, loadPartDocText } from '@/persistence/docSchema'
import { PART_DOC_SCHEMA } from '@/persistence/partDocSchema'
import { partDocStrictProblem } from '@/drive/strictDoc'

// The document's length unit at the load boundary: the browser loader refuses a
// malformed value by field name, and the published schema carries the field so
// the strict MCP/CLI validator accepts an inch document.
describe('the part document length unit', () => {
  it('loads an inch document and keeps the value', () => {
    const result = loadPartDoc({ version: 1, kind: 'part', length_unit: 'inch', features: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.length_unit).toBe('inch')
  })

  it('loads a document without the field and does not invent it', () => {
    const result = loadPartDoc({ version: 1, kind: 'part', features: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Absence is the canonical millimetre spelling; writing it during load would
    // move every existing document's hash.
    expect('length_unit' in result.doc).toBe(false)
  })

  it('refuses a unit outside the two spellings, naming the field', () => {
    for (const length_unit of ['in', 'millimetre', 25.4, null, false]) {
      const result = loadPartDoc({ version: 1, kind: 'part', length_unit, features: [] })
      expect(result.ok, `length_unit ${JSON.stringify(length_unit)}`).toBe(false)
      if (result.ok) continue
      expect(result.error.field).toBe('length_unit')
      expect(result.error.message).toContain('"mm" or "inch"')
    }
  })

  it('refuses a malformed unit in YAML text as well', () => {
    const result = loadPartDocText('kind: part\nlength_unit: inches\nfeatures: []', { name: 'Bracket' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('length_unit')
  })

  it('publishes the field with its enum in the part-document schema', () => {
    const properties = PART_DOC_SCHEMA.properties as Record<string, { enum?: string[] }>
    expect(properties.length_unit.enum).toEqual(['mm', 'inch'])
  })

  it('passes the strict MCP document check, and a bad unit fails it', () => {
    // The strict validator uses the published schema with
    // additionalProperties: false, so without the property an authored inch
    // document would be refused at the drive boundary while the browser loader
    // accepted it.
    expect(partDocStrictProblem({ version: 1, kind: 'part', length_unit: 'inch', features: [] })).toBeNull()
    expect(partDocStrictProblem({ version: 1, kind: 'part', length_unit: 'in', features: [] }))
      .toContain('length_unit')
  })
})
