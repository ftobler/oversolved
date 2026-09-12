import { describe, it, expect } from 'vitest'
import { DirectoryCarrier } from '../directoryCarrier'
import { ZipCarrier, buildZipBytes, readZipFiles } from '../zipCarrier'
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
  it('two zip saves of one tree are byte-equal', async () => {
    const carrier = new ZipCarrier()
    const tree = sample()
    await carrier.save(tree)
    const first = carrier.blob
    await carrier.save(await carrier.open())
    expect(carrier.blob).toEqual(first)
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

  it('unzipping a zip into a folder and opening it yields the same tree and bytes', async () => {
    const carrier = new ZipCarrier()
    const tree = sample()
    await carrier.save(tree)

    const dir = await seedDirectory(await readZipFiles(carrier.blob))
    const folder = new DirectoryCarrier(dir)
    const opened = await folder.open()
    // The folder leaves file bytes lazy, so materialize before serializing.
    for (const [id, row] of Object.entries(opened.manifest.entries)) {
      if (row.kind !== 'file' || opened.contents.has(id)) continue
      const entry = await folder.read(id)
      if (entry.bytes) opened.contents.set(id, { bytes: entry.bytes })
    }

    expect(serializeTree(opened)).toEqual(serializeTree(tree))
    expect((await folder.read('b')).bytes).toEqual(bytesOf([1, 2, 3, 4]))
    expect((await folder.read('a')).text).toBe('kind: part\n# odd   spacing\n')
  })

  it('a folder save twice is a fixed point', async () => {
    const carrier = new DirectoryCarrier(fakeDirectory())
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# odd   spacing\n' }),
      documentEntry('c', 'C', { text: 'kind: assembly\n' }),
    ])
    await carrier.save(tree)
    const first = serializeTree(await carrier.open())
    await carrier.save(await carrier.open())
    expect(serializeTree(await carrier.open())).toEqual(first)
  })
})
