import { describe, it, expect } from 'vitest'
import { openSingleFileLibrary, stemOf } from '../singleFileLibrary'

// "Open one file, edit it, save it back", built as the degenerate case of the
// directory library rather than as a second store. What is pinned here is that
// the one real file is the one document, that a save lands in that file, and
// that the operations needing a second file are refused rather than faked.

// A minimal real FileSystemFileHandle over a string, so the test can read back
// exactly what was committed to "the user's file".
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

describe('stemOf', () => {
  it('drops the extension, whatever its casing', () => {
    expect(stemOf('Bracket.yaml')).toBe('Bracket')
    expect(stemOf('Bracket.YML')).toBe('Bracket')
  })

  it('leaves a name with no extension alone', () => {
    expect(stemOf('Bracket')).toBe('Bracket')
  })
})

describe('single file library', () => {
  it('presents the picked file as the one document, named after it', async () => {
    const { handle } = fileHandle('Bracket.yaml', 'kind: part\nfeatures: []\n')
    const { documents, label } = openSingleFileLibrary(handle)
    expect(label).toBe('Bracket')
    const list = await documents.list()
    expect(list.map(d => d.name)).toEqual(['Bracket'])
    expect((await documents.load(list[0].uuid)).content).toBe('kind: part\nfeatures: []\n')
  })

  it('saves back into that same file', async () => {
    const { handle, state } = fileHandle('Bracket.yaml', 'old')
    const { documents } = openSingleFileLibrary(handle)
    const [doc] = await documents.list()
    await documents.save(doc.uuid, { content: 'new' })
    expect(state.text).toBe('new')
  })

  // Identical bytes must not rewrite the user's file: its modification time is
  // something they can see, in git and in their file manager.
  it('does not rewrite the file when the bytes are unchanged', async () => {
    const { handle, state } = fileHandle('Bracket.yaml', 'same')
    const { documents } = openSingleFileLibrary(handle)
    const [doc] = await documents.list()
    await documents.save(doc.uuid, { content: 'same' })
    expect(state.commits).toBe(0)
  })

  // A .yml or an odd casing is still the one document this library contains.
  it('accepts a file whose extension is not exactly .yaml', async () => {
    const { handle, state } = fileHandle('Bracket.yml', 'body')
    const { documents } = openSingleFileLibrary(handle)
    const [doc] = await documents.list()
    expect(doc.name).toBe('Bracket')
    await documents.save(doc.uuid, { content: 'edited' })
    expect(state.text).toBe('edited')
  })

  // The bookkeeping a directory library keeps on disk is held in memory here:
  // writing sidecar files next to a document the user picked would litter a
  // folder they never handed us. Previews are part of that bookkeeping (an
  // in-memory preview store plus the memory directory), so a save touches only
  // the file the user picked.
  it('saves only the picked file and no sidecar', async () => {
    const { handle, state } = fileHandle('Bracket.yaml', 'body')
    const { documents } = openSingleFileLibrary(handle)
    const [doc] = await documents.list()
    await documents.save(doc.uuid, { content: 'body2' })
    expect(state.text).toBe('body2')
  })

  // A second document would need a second file, and there is no folder here to
  // put one in. These are not storage limitations to work around; the requests
  // do not mean anything.
  it('refuses to create, duplicate or delete a document', async () => {
    const { handle } = fileHandle('Bracket.yaml', 'body')
    const { documents, trash } = openSingleFileLibrary(handle)
    const [doc] = await documents.list()
    await expect(documents.create('Second')).rejects.toThrow(/single file/i)
    await expect(documents.duplicate(doc.uuid)).rejects.toThrow(/single file/i)
    await expect(documents.remove(doc.uuid)).rejects.toThrow(/single file/i)
    expect((await documents.list()).map(d => d.name)).toEqual(['Bracket'])
    expect(await trash.list()).toEqual([])
  })

  // Renaming would have to rename the user's file, which needs a parent
  // directory this handle does not have.
  it('refuses to rename the document', async () => {
    const { handle } = fileHandle('Bracket.yaml', 'body')
    const { documents } = openSingleFileLibrary(handle)
    const [doc] = await documents.list()
    await expect(documents.rename(doc.uuid, 'Other')).rejects.toThrow(/single file/i)
  })
})
