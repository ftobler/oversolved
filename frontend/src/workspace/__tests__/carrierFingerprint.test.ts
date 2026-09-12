import { describe, it, expect, beforeEach } from 'vitest'
import { fingerprintManifest } from '../carrierFingerprint'
import { DirectoryCarrier } from '../directoryCarrier'
import { ZipCarrier, buildZipBytes } from '../zipCarrier'
import { parseManifest, serializeManifest } from '../manifest'
import { MANIFEST_PATH } from '../paths'
import { IdbWorkspaceStore } from '../store'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The carrier-under-working-copy fingerprint hashes the canonical manifest,
// never the raw file, so an external reformat is not a change and a real edit
// is. The folder and zip carriers must reach the same hash for the same tree.

const tree = () => treeWith([documentEntry('a', 'A', { text: 'kind: part\n' })])

function zipHandle(state: { bytes: Uint8Array }): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name: 'ws.zip',
    async getFile() {
      const bytes = state.bytes
      return {
        size: bytes.byteLength,
        lastModified: 0,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        },
      }
    },
    async createWritable() {
      let buffer = new Uint8Array(0)
      return {
        async write(data: Uint8Array) { buffer = new Uint8Array(data) },
        async close() { state.bytes = buffer },
        async abort() {},
      }
    },
  } as unknown as FileSystemFileHandle
}

describe('carrierFingerprint', () => {
  it('is stable across a canonical reformat and moves on a real edit', async () => {
    const manifest = tree().manifest
    const base = await fingerprintManifest(manifest)

    // Re-parsing the serialized bytes is the external-reformat case: same
    // meaning, different spacing or key order, so the hash must not move.
    const reparsed = parseManifest(serializeManifest(manifest))
    expect(await fingerprintManifest(reparsed)).toBe(base)

    const changed = { ...manifest, entries: { ...manifest.entries } }
    delete changed.entries.a
    expect(await fingerprintManifest(changed)).not.toBe(base)
  })

  it('the folder carrier ignores an external reformat and reports a real edit', async () => {
    const dir = fakeDirectory()
    const carrier = new DirectoryCarrier(dir)
    await carrier.save(tree())
    const before = await carrier.readManifestFingerprint()

    dir.putText(MANIFEST_PATH, `# a comment\n${dir.snapshot()[MANIFEST_PATH]}`)
    expect(await carrier.readManifestFingerprint()).toBe(before)

    const changed = { ...parseManifest(dir.snapshot()[MANIFEST_PATH]), entries: {} }
    dir.putText(MANIFEST_PATH, serializeManifest(changed))
    expect(await carrier.readManifestFingerprint()).not.toBe(before)
  })

  it('the zip carrier reaches the same hash as the folder carrier', async () => {
    const dir = fakeDirectory()
    const treeValue = tree()
    await new DirectoryCarrier(dir).save(treeValue)

    const bytes = await buildZipBytes(treeValue)
    expect(await new ZipCarrier(bytes).readManifestFingerprint())
      .toBe(await new DirectoryCarrier(dir).readManifestFingerprint())
  })

  it('reads null for a missing or unreadable manifest, not a false change', async () => {
    const dir = fakeDirectory()
    expect(await new DirectoryCarrier(dir).readManifestFingerprint()).toBeNull()
    expect(await new ZipCarrier(new Uint8Array(0)).readManifestFingerprint()).toBeNull()
  })
})

describe('open detects a zip manifest written behind the working copy', () => {
  beforeEach(resetWorkspaceIdb)

  it('reports externalChanged only after the archive moves', async () => {
    const store = new IdbWorkspaceStore()
    const state: { bytes: Uint8Array } = { bytes: new Uint8Array(0) }
    const { workspace } = await store.create('Asm', {
      docKind: 'assembly',
      target: { kind: 'zip', label: 'ws.zip', handle: zipHandle(state) },
    })
    await store.save(workspace, treeWith([documentEntry('a', 'Asm')], workspace))
    expect((await store.open(workspace)).externalChanged).toBe(false)

    // An external tool rebuilds the archive with a different entry set.
    state.bytes = await buildZipBytes(treeWith([documentEntry('b', 'Other')], workspace))
    expect((await store.open(workspace)).externalChanged).toBe(true)
  })
})
