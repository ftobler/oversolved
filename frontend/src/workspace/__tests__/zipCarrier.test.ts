import { describe, it, expect } from 'vitest'
import { ZipCarrier, buildZipBytes } from '../zipCarrier'
import { serializeTree } from '../serializer'
import type { WorkspaceTree } from '../types'
import { addReference } from '../refs'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'

// Dedicated ZipCarrier coverage: the pinned central-directory metadata that
// makes two saves byte-equal, the no-op save, and concurrent whole-file writes.
// These carry forward what the retired FileSystemDirectoryStore suite asserted
// about archive determinism.

function sample(): WorkspaceTree {
  const tree = treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3, 4]), 'application/step'),
  ])
  addReference(tree, 'a', 'b')
  return tree
}

interface CentralEntry {
  name: string
  method: number
  date: number
  time: number
  external: number
  comment: string
}

// The central directory read back from raw bytes, so the pinning is checked
// against what an unzip tool sees, not JSZip's in-memory objects.
function centralDirectory(bytes: Uint8Array): CentralEntry[] {
  const out: CentralEntry[] = []
  const decoder = new TextDecoder()
  for (let i = 0; i <= bytes.length - 46; i++) {
    if (!(bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x01 && bytes[i + 3] === 0x02)) continue
    const method = bytes[i + 10] | (bytes[i + 11] << 8)
    const time = bytes[i + 12] | (bytes[i + 13] << 8)
    const date = bytes[i + 14] | (bytes[i + 15] << 8)
    const commentLen = bytes[i + 32] | (bytes[i + 33] << 8)
    const nameLen = bytes[i + 28] | (bytes[i + 29] << 8)
    const extraLen = bytes[i + 30] | (bytes[i + 31] << 8)
    const external = (bytes[i + 38] | (bytes[i + 39] << 8) | (bytes[i + 40] << 16) | (bytes[i + 41] << 24)) >>> 0
    const name = decoder.decode(bytes.subarray(i + 46, i + 46 + nameLen))
    const comment = decoder.decode(bytes.subarray(i + 46 + nameLen, i + 46 + nameLen + commentLen))
    out.push({ name, method, date, time, external, comment })
    i += 45 + nameLen + extraLen + commentLen
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

function archiveComment(bytes: Uint8Array): string {
  const decoder = new TextDecoder()
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      const len = bytes[i + 20] | (bytes[i + 21] << 8)
      return decoder.decode(bytes.subarray(i + 22, i + 22 + len))
    }
  }
  return ''
}

describe('ZipCarrier pinned archive metadata', () => {
  it('pins STORE, a fixed date, DOS attributes, empty comments and the tree order', async () => {
    const bytes = await buildZipBytes(sample())
    const central = centralDirectory(bytes)

    expect(central.map(entry => entry.name)).toEqual(serializeTree(sample()).map(file => file.path))
    for (const entry of central) {
      expect(entry.method).toBe(0)  // STORE
      expect(decodeDosDate(entry.date, entry.time).toISOString()).toBe('1980-01-01T00:00:00.000Z')
      // Generated with platform DOS, so the pinned external attributes are the
      // DOS bits (0) and no per-entry comment rides along.
      expect(entry.external).toBe(0)
      expect(entry.comment).toBe('')
    }
    expect(archiveComment(bytes)).toBe('')
  })

  it('saving an opened tree unchanged is a no-op fixed point', async () => {
    const carrier = new ZipCarrier()
    await carrier.save(sample())
    const first = carrier.blob
    await carrier.save(await carrier.open())
    expect(carrier.blob).toEqual(first)
    expect(await carrier.readManifestFingerprint()).not.toBeNull()
  })

  it('concurrent saves each commit a whole archive, never a torn one', async () => {
    const carrier = new ZipCarrier()
    const a = treeWith([documentEntry('a', 'A', { text: 'kind: part\n' })])
    const b = treeWith([documentEntry('b', 'B', { text: 'kind: part\n' })])
    await Promise.all([carrier.save(a), carrier.save(b)])

    const opened = await new ZipCarrier(carrier.blob).open()
    const names = Object.values(opened.manifest.entries).map(row => row.name)
    expect(names).toHaveLength(1)
    expect(['A', 'B']).toContain(names[0])
  })
})
