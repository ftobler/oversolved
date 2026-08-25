import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { buildStepContent, importStepFile, stepImportLimitError, MAX_STEP_IMPORT_BYTES } from '../stepImport'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import { resetDbConnection } from '../idb'

describe('buildStepContent', () => {
  it('emits the builtin reference features plus an import_step feature', () => {
    const yaml = buildStepContent('QUFBQQ==', 'IM1')
    const doc = parseYaml(yaml)
    const ids = doc.features.map((f: { id: string }) => f.id)
    expect(ids).toEqual(['Origin', 'Top', 'Front', 'Right', 'IM1'])
    const imp = doc.features.find((f: { id: string }) => f.id === 'IM1')
    expect(imp.kind).toBe('import_step')
    expect(imp.file_data).toBe('QUFBQQ==')
    expect(imp.label).toBeUndefined()
  })

  it('passes the label through to the import_step feature', () => {
    const yaml = buildStepContent('QUFBQQ==', 'IM1', 'bracket')
    const doc = parseYaml(yaml)
    const imp = doc.features.find((f: { id: string }) => f.id === 'IM1')
    expect(imp.label).toBe('bracket')
  })

  it('generates a feature id when none is given', () => {
    const yaml = buildStepContent('QUFBQQ==')
    const doc = parseYaml(yaml)
    const imp = doc.features.find((f: { kind: string }) => f.kind === 'import_step')
    expect(typeof imp.id).toBe('string')
    expect(imp.id.length).toBeGreaterThan(0)
  })
})

describe('importStepFile', () => {
  beforeEach(() => {
    resetFakeIndexedDb()
    resetDbConnection()
  })

  it('creates + saves a document carrying the STEP bytes', async () => {
    const store = new IndexedDbDocumentStore()
    const bytes = 'ISO-10303-21;\nHEADER;\nENDSEC;\nEND-STEP;\n'
    const file = new File([bytes], 'bracket.step', { type: 'application/step' })
    const uuid = await importStepFile(store, file)
    const payload = await store.load(uuid)
    expect(payload.name).toBe('bracket')
    const doc = parseYaml(payload.content)
    const imp = doc.features.find((f: { kind: string }) => f.kind === 'import_step')
    expect(imp).toBeTruthy()
    expect(typeof imp.file_data).toBe('string')
    expect(imp.file_data.length).toBeGreaterThan(0)
    expect(imp.label).toBe('bracket.step')
  })

  it('rejects an empty STEP file', async () => {
    const store = new IndexedDbDocumentStore()
    const file = new File([''], 'empty.step', { type: 'application/step' })
    await expect(importStepFile(store, file)).rejects.toThrow(/empty/)
  })

  it('leaves no orphan document when the save fails after create', async () => {
    const store = new IndexedDbDocumentStore()
    vi.spyOn(store, 'save').mockRejectedValue(new Error('quota exceeded'))
    const file = new File(['ISO-10303-21;'], 'bracket.step')
    await expect(importStepFile(store, file)).rejects.toThrow(/quota/)
    expect(await store.list()).toHaveLength(0)
  })

  it('rejects a file over the size cap before any store call', async () => {
    const store = new IndexedDbDocumentStore()
    const createSpy = vi.spyOn(store, 'create')
    const file = new File([new Uint8Array(MAX_STEP_IMPORT_BYTES + 1)], 'big.step')
    await expect(importStepFile(store, file)).rejects.toThrow(/too large/)
    // The guard fires before the expensive read, so nothing is created either.
    expect(createSpy).not.toHaveBeenCalled()
    expect(await store.list()).toHaveLength(0)
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