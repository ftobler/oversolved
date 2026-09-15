import { describe, it, expect } from 'vitest'
import { readDirectoryTree, writeDirectoryTree } from '../directoryCarrier'
import { buildZipBytes, readZipFiles, readZipTree } from '../zipCarrier'
import { serializeTree } from '../serializer'
import type { SerializedFile, WorkspaceTree } from '../types'
import { addReference } from '../refs'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// I4: one canonical tree, two carriers. The manifest and payloads a folder
// writes are byte-identical to the ones a zip writes, and the zip pins every
// field JSZip would otherwise take from the clock or the platform, so two saves
// of one tree are byte-equal. This is the assertion C1 suspended.

function sample(): WorkspaceTree {
  const tree = treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n# odd   spacing\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3, 4]), 'application/step'),
    documentEntry('c', 'C', { text: 'kind: assembly\n' }),
  ])
  addReference(tree, 'a', 'b')
  addReference(tree, 'c', 'a')
  return tree
}

interface CentralEntry {
  name: string
  method: number
  date: number
  time: number
}

// The central directory read back from the raw bytes, so the pinning is checked
// against what an unzip tool sees, not against JSZip's in-memory objects.
function centralDirectory(bytes: Uint8Array): CentralEntry[] {
  const out: CentralEntry[] = []
  for (let i = 0; i <= bytes.length - 46; i++) {
    if (!(bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02)) continue
    const method = bytes[i + 10] | (bytes[i + 11] << 8)
    const time = bytes[i + 12] | (bytes[i + 13] << 8)
    const date = bytes[i + 14] | (bytes[i + 15] << 8)
    const nameLen = bytes[i + 28] | (bytes[i + 29] << 8)
    const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLen))
    out.push({ name, method, date, time })
    i += 45 + nameLen
  }
  return out
}

function decodeDosDate(date: number, time: number): Date {
  const day = date & 0x1f
  const month = (date >> 5) & 0x0f
  const year = ((date >> 9) & 0x7f) + 1980
  const second = (time & 0x1f) * 2
  const minute = (time >> 5) & 0x3f
  const hour = (time >> 11) & 0x1f
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

async function seedDirectory(files: SerializedFile[]): Promise<FileSystemDirectoryHandle> {
  const dir = fakeDirectory()
  for (const file of files) {
    const segments = file.path.split('/')
    const name = segments.pop()!
    let current = dir as unknown as FileSystemDirectoryHandle
    for (const segment of segments) current = await current.getDirectoryHandle(segment, { create: true })
    const handle = await current.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(file.data as unknown as FileSystemWriteChunkType)
    await writable.close()
  }
  return dir
}

describe('I4: folder and zip are one canonical tree', () => {
  it('two zip writes of one tree are byte-equal', async () => {
    const first = await buildZipBytes(sample())
    expect(await buildZipBytes(await readZipTree(first))).toEqual(first)
  })

  it('pins STORE, a fixed date and the serializeTree order on every entry', async () => {
    const bytes = await buildZipBytes(sample())
    const central = centralDirectory(bytes)
    const expected = serializeTree(sample()).map(file => file.path)
    expect(central.map(entry => entry.name)).toEqual(expected)
    for (const entry of central) {
      expect(entry.method).toBe(0)  // STORE
      expect(decodeDosDate(entry.date, entry.time).toISOString()).toBe('1980-01-01T00:00:00.000Z')
    }
  })

  it('unzipping a zip into a folder and reading it yields the same tree and bytes', async () => {
    const tree = sample()
    const dir = await seedDirectory(await readZipFiles(await buildZipBytes(tree)))
    const opened = await readDirectoryTree(dir)

    expect(serializeTree(opened)).toEqual(serializeTree(tree))
    expect(opened.contents.get('b')?.bytes).toEqual(bytesOf([1, 2, 3, 4]))
    expect(opened.contents.get('a')?.text).toBe('kind: part\n# odd   spacing\n')
  })

  it('a folder written twice is a fixed point', async () => {
    const dir = fakeDirectory()
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# odd   spacing\n' }),
      documentEntry('c', 'C', { text: 'kind: assembly\n' }),
    ])
    await writeDirectoryTree(dir, tree)
    const first = serializeTree(await readDirectoryTree(dir))
    await writeDirectoryTree(dir, await readDirectoryTree(dir))
    expect(serializeTree(await readDirectoryTree(dir))).toEqual(first)
  })
})
