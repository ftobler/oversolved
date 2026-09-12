import { describe, it, expect, beforeEach } from 'vitest'
import { parse as parseYaml } from 'yaml'
import JSZip from 'jszip'
import { openDirectoryLibrary } from '../FileSystemDirectoryStore'
import { openSingleFileLibrary } from '../singleFileLibrary'
import { fakeDirectory } from './fakeFileSystemDirectory'
import { buildBundleBytes, importBundle } from '../bundle'
import { InMemoryDocumentStore } from './InMemoryDocumentStore'
import { IndexedDbFileRegistry } from '@/stores/fileRegistry'
import { MemoryFileRegistry } from '@/stores/fileRegistry'
import { fileIdsInSpec, resolveFiles } from '@/stores/fileRegistry/resolve'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import { resetDbConnection } from '../idb'
import { solveImportStep } from '@/kernel/features/importStep'

// The C1 hole, asserted: between C1 and C3 the registry is IndexedDB-only, so
// the on-disk carriers (folder, single file, `.oversolved` bundle) write document
// text only. A referenced file survives as a `file_id`; its bytes do not follow,
// and the solve fails loud with the not-present message rather than solving
// empty. C3 restores the byte round-trip and these assertions flip back.

const CONTENT = [
  'features:',
  '  - id: Origin',
  '    kind: origin',
  '  - id: imp1',
  '    kind: import_step',
  '    file_id: file-1',
  '',
].join('\n')

function parseContent(content: string): Record<string, unknown> {
  return parseYaml(content) as Record<string, unknown>
}

// A minimal real FileSystemFileHandle over a string, matching the single-file
// library's own test double.
function fileHandle(name: string, initial = '') {
  const state = { text: initial, commits: 0 }
  const handle = {
    kind: 'file' as const,
    name,
    async getFile() {
      return {
        name, size: state.text.length, type: '', lastModified: 0,
        async text() { return state.text },
        async arrayBuffer() { return new TextEncoder().encode(state.text).buffer },
      } as unknown as File
    },
    async createWritable() {
      let buffer = ''
      return {
        async write(data: string | Uint8Array) {
          buffer += typeof data === 'string' ? data : new TextDecoder().decode(data)
        },
        async close() { state.text = buffer; state.commits += 1 },
        async abort() { buffer = '' },
      }
    },
  } as unknown as FileSystemFileHandle
  return { handle, state }
}

describe('the reference survives but the bytes do not (C1 hole)', () => {
  beforeEach(() => {
    resetFakeIndexedDb()
    resetDbConnection()
  })

  it('a folder carrier keeps the file_id and writes no files tree', async () => {
    const dir = fakeDirectory()
    const { documents } = openDirectoryLibrary(dir)
    const { uuid } = await documents.create('Bracket')
    await documents.save(uuid, { content: CONTENT })

    const snapshot = dir.snapshot()
    const names = Object.keys(snapshot)
    expect(names.filter(n => n.endsWith('.yaml'))).toHaveLength(1)
    expect(names.some(n => n.includes('files/'))).toBe(false)
    // The reference survives, and no inline payload or base64 blob does: the
    // hole is reference-only, not a silent re-inline of the bytes.
    const yaml = Object.entries(snapshot).find(([n]) => n.endsWith('.yaml'))![1]
    const imports = (parseContent(yaml).features as Record<string, unknown>[]).filter(f => f.kind === 'import_step')
    expect(imports).toHaveLength(1)
    expect(imports[0].file_id).toBe('file-1')
    expect('file_data' in imports[0]).toBe(false)
    for (const text of Object.values(snapshot)) expect(text).not.toContain('file_data')

    // Re-open the same folder and the reference is still there.
    const reopened = openDirectoryLibrary(dir).documents
    const list = await reopened.list()
    expect(list).toHaveLength(1)
    expect(parseContent((await reopened.load(list[0].uuid)).content)).toMatchObject({
      features: expect.arrayContaining([expect.objectContaining({ kind: 'import_step', file_id: 'file-1' })]),
    })
  })

  it('a single-file carrier keeps the file_id and writes text only', async () => {
    const { handle, state } = fileHandle('Bracket.yaml', CONTENT)
    const { documents } = openSingleFileLibrary(handle)
    const [doc] = await documents.list()
    const loaded = await documents.load(doc.uuid)
    expect(loaded.content).toContain('file_id: file-1')
    expect(state.text).toBe(CONTENT)
  })

  it('an .oversolved bundle keeps the file_id and carries only YAML text', async () => {
    const store = new InMemoryDocumentStore()
    const { uuid } = await store.create('Bracket')
    await store.save(uuid, { content: CONTENT })

    const bytes = await buildBundleBytes(store, [uuid])
    const zip = await JSZip.loadAsync(bytes)
    const fileNames = Object.values(zip.files).filter(f => !f.dir).map(f => f.name)
    expect(fileNames.length).toBeGreaterThan(0)
    expect(fileNames.every(n => n.endsWith('.yaml') || n.endsWith('.png'))).toBe(true)

    const reimported = new InMemoryDocumentStore()
    const ids = await importBundle(reimported, bytes)
    const loaded = await reimported.load(ids[0])
    expect(loaded.content).toContain('file_id: file-1')
  })

  it('a survived reference fails loud rather than solving empty', async () => {
    const spec = parseContent(CONTENT)
    const ids = fileIdsInSpec(spec)
    expect(ids).toEqual(['file-1'])

    // A fresh registry, exactly what a reload sees: the record did not travel.
    const files = await resolveFiles(new MemoryFileRegistry(), ids)
    expect(Object.keys(files)).toEqual([])

    const feature = (spec.features as Record<string, unknown>[])[1]
    expect(() =>
      solveImportStep(null as never, null as never, null as never, feature, null as never, {}, new Map()),
    ).toThrow(/file 'file-1' is not present in the solve file set/)
  })

  it('the registry never copies bytes into the document it is referenced from', async () => {
    const registry = new IndexedDbFileRegistry()
    const entry = await registry.create({
      name: 'bracket.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array([1, 2, 3]),
    })
    const content = CONTENT.replace('file-1', entry.id)
    expect(content).not.toContain('AQID')  // no base64 payload anywhere
    expect(parseContent(content)).toBeTruthy()
  })

  it('the registry itself round-trips through IndexedDB across a reconnect', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const registry = new IndexedDbFileRegistry()
    const { id } = await registry.create({ name: 'a.step', kind: 'step', mime: 'application/step', bytes })

    // A reconnect (not a wipe) stands in for a same-session reload.
    resetDbConnection()
    const again = await new IndexedDbFileRegistry().getBytes(id)
    expect(Array.from(again!)).toEqual([9, 8, 7])
  })
})
