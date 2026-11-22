import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { buildStepContent, stepImportLimitError, MAX_STEP_IMPORT_BYTES } from '../stepImport'

// The synthesized-part shape. Adoption (`workspace/import.ts`) is the one path
// that builds a document for a dropped STEP now: it stores the bytes as a
// workspace file entry, then calls `buildStepContent` with that freshly minted
// file id. The old file-backed-library `importStepFile` is retired with the
// library seam; its registry write and compensating delete have no analogue
// here because the workspace entry IS the byte store.

describe('buildStepContent', () => {
  it('emits the builtin reference features plus a file reference on import_step', () => {
    const yaml = buildStepContent('file-uuid-1', 'IM1')
    const doc = parseYaml(yaml)
    const ids = doc.features.map((f: { id: string }) => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'IM1'])
    const imp = doc.features.find((f: { id: string }) => f.id === 'IM1')
    expect(imp.kind).toBe('import_step')
    expect(imp.file_id).toBe('file-uuid-1')
    expect(imp.file_data).toBeUndefined()
    expect(imp.label).toBeUndefined()
  })

  it('passes the label through to the import_step feature', () => {
    const yaml = buildStepContent('file-uuid-1', 'IM1', 'bracket')
    const doc = parseYaml(yaml)
    const imp = doc.features.find((f: { id: string }) => f.id === 'IM1')
    expect(imp.label).toBe('bracket')
  })

  it('generates a feature id when none is given', () => {
    const yaml = buildStepContent('file-uuid-1')
    const doc = parseYaml(yaml)
    const imp = doc.features.find((f: { kind: string }) => f.kind === 'import_step')
    expect(typeof imp.id).toBe('string')
    expect(imp.id.length).toBeGreaterThan(0)
  })
})

describe('stepImportLimitError', () => {
  it('accepts a file exactly at the cap', () => {
    expect(stepImportLimitError(MAX_STEP_IMPORT_BYTES)).toBeNull()
  })

  it('reports an oversized file with both sizes', () => {
    expect(stepImportLimitError(MAX_STEP_IMPORT_BYTES + 1)).toMatch(/75\.0 MB/)
  })
})
