import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fileIdsInParts, fileIdsInSpec, resolveFiles, resolveFilesSessionFirst } from '../resolve'
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

describe('resolveFilesSessionFirst', () => {
  const registry = new MemoryFileRegistry()
  const resolver = {
    resolveFile: vi.fn(async (): Promise<Uint8Array | undefined> => new Uint8Array([7, 8, 9])),
  }

  beforeEach(() => {
    resolver.resolveFile.mockClear()
  })

  it('prefers the workspace resolver over the flat registry', async () => {
    const files = await resolveFilesSessionFirst(resolver, registry, ['f1', 'f2'])
    expect(resolver.resolveFile).toHaveBeenCalledWith('f1')
    expect(resolver.resolveFile).toHaveBeenCalledWith('f2')
    expect(Array.from(files.f1)).toEqual([7, 8, 9])
    expect(Array.from(files.f2)).toEqual([7, 8, 9])
  })

  it('falls back to the registry when no workspace is open', async () => {
    const a = await registry.create({ name: 'a.step', kind: 'step', bytes: new Uint8Array([1, 2]) })
    const files = await resolveFilesSessionFirst(null, registry, [a.id, 'missing'])
    expect(Object.keys(files)).toEqual([a.id])
    expect(Array.from(files[a.id])).toEqual([1, 2])
    expect(resolver.resolveFile).not.toHaveBeenCalled()
  })

  it('omits an id the resolver cannot satisfy', async () => {
    resolver.resolveFile.mockResolvedValueOnce(undefined)
    const files = await resolveFilesSessionFirst(resolver, registry, ['f1'])
    expect(files).toEqual({})
  })
})
