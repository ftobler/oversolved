import { describe, it, expect } from 'vitest'
import { fileIdsInParts, fileIdsInSpec, resolveFiles } from '../resolve'
import { MemoryFileRegistry } from '../memoryFileRegistry'

describe('fileIdsInSpec', () => {
  it('finds only import_step ids', () => {
    const ids = fileIdsInSpec({ features: [
      { id: 'a', kind: 'sketch' },
      { id: 'b', kind: 'import_step', file_id: 'file-b' },
      { id: 'c', kind: 'extrude' },
    ] })
    expect(ids).toEqual(['file-b'])
  })

  it('dedupes repeated references to the same file', () => {
    const ids = fileIdsInSpec({ features: [
      { id: 'b', kind: 'import_step', file_id: 'file-b' },
      { id: 'c', kind: 'import_step', file_id: 'file-b' },
    ] })
    expect(ids).toEqual(['file-b'])
  })

  it('ignores an empty or absent file_id and a missing features array', () => {
    expect(fileIdsInSpec({})).toEqual([])
    expect(fileIdsInSpec({ features: [
      { id: 'b', kind: 'import_step' },
      { id: 'c', kind: 'import_step', file_id: '' },
    ] })).toEqual([])
  })
})

describe('fileIdsInParts', () => {
  it('unions and dedupes every part spec', () => {
    const parts = [
      { spec: { features: [{ kind: 'import_step', file_id: 'f1' }] }, transform: {} },
      { spec: { features: [{ kind: 'import_step', file_id: 'f1' }, { kind: 'import_step', file_id: 'f2' }] }, transform: {} },
    ] as unknown as Parameters<typeof fileIdsInParts>[0]
    expect(new Set(fileIdsInParts(parts))).toEqual(new Set(['f1', 'f2']))
  })
})

describe('resolveFiles', () => {
  it('resolves present ids and omits a missing one', async () => {
    const registry = new MemoryFileRegistry()
    const a = await registry.create({ name: 'a.step', kind: 'step', bytes: new Uint8Array([1, 2]) })
    const files = await resolveFiles(registry, [a.id, 'missing'])
    expect(Object.keys(files)).toEqual([a.id])
    expect(Array.from(files[a.id])).toEqual([1, 2])
  })
})
