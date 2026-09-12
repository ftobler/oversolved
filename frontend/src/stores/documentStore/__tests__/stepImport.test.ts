import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { buildStepContent, importStepFile, stepImportLimitError, MAX_STEP_IMPORT_BYTES } from '../stepImport'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import { resetDbConnection } from '../idb'
import { getFileRegistry } from '@/stores/fileRegistry'

// jsdom's File has no arrayBuffer(), which the registry-backed import path
// reads. A plain object is what the production read actually touches.
function makeFile(name: string, data: Uint8Array): File {
  return {
    name,
    size: data.byteLength,
    async arrayBuffer() {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    },
  } as unknown as File
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

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

describe('importStepFile', () => {
  beforeEach(() => {
    resetFakeIndexedDb()
    resetDbConnection()
  })

  it('creates + saves a document referencing a registry record holding the bytes', async () => {
    const store = new IndexedDbDocumentStore()
    const bytes = 'ISO-10303-21;\nHEADER;\nENDSEC;\nEND-STEP;\n'
    const file = makeFile('bracket.step', encode(bytes))
    const uuid = await importStepFile(store, file)
    const payload = await store.load(uuid)
    expect(payload.name).toBe('bracket')
    const doc = parseYaml(payload.content)
    const imp = doc.features.find((f: { kind: string }) => f.kind === 'import_step')
    expect(imp).toBeTruthy()
    expect(typeof imp.file_id).toBe('string')
    expect(imp.file_data).toBeUndefined()
    expect(imp.label).toBe('bracket.step')

    // The registry record holds the exact file bytes under that id.
    const entry = await getFileRegistry().get(imp.file_id)
    expect(entry).toBeTruthy()
    expect(entry!.name).toBe('bracket.step')
    expect(Array.from(entry!.bytes)).toEqual(Array.from(new TextEncoder().encode(bytes)))
  })

  it('rejects an empty STEP file', async () => {
    const store = new IndexedDbDocumentStore()
    const file = makeFile('empty.step', new Uint8Array(0))
    await expect(importStepFile(store, file)).rejects.toThrow(/empty/)
  })

  it('leaves no orphan document or registry record when the save fails after create', async () => {
    const store = new IndexedDbDocumentStore()
    vi.spyOn(store, 'save').mockRejectedValue(new Error('quota exceeded'))
    const file = makeFile('bracket.step', encode('ISO-10303-21;'))
    await expect(importStepFile(store, file)).rejects.toThrow(/quota/)
    expect(await store.list()).toHaveLength(0)
    expect(await getFileRegistry().list()).toHaveLength(0)
  })

  it('leaves no registry record when the document create itself fails', async () => {
    const store = new IndexedDbDocumentStore()
    vi.spyOn(store, 'create').mockRejectedValue(new Error('create failed'))
    const file = makeFile('bracket.step', encode('ISO-10303-21;'))
    await expect(importStepFile(store, file)).rejects.toThrow(/create failed/)
    expect(await store.list()).toHaveLength(0)
    expect(await getFileRegistry().list()).toHaveLength(0)
  })

  it('rejects a file over the size cap before any read or store call', async () => {
    const store = new IndexedDbDocumentStore()
    const createSpy = vi.spyOn(store, 'create')
    const file = makeFile('big.step', new Uint8Array(MAX_STEP_IMPORT_BYTES + 1))
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer')
    await expect(importStepFile(store, file)).rejects.toThrow(/too large/)
    // The guard fires before the expensive read, so nothing is created either.
    expect(createSpy).not.toHaveBeenCalled()
    expect(arrayBufferSpy).not.toHaveBeenCalled()
    expect(await store.list()).toHaveLength(0)
    expect(await getFileRegistry().list()).toHaveLength(0)
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
