import { describe, it, expect, vi } from 'vitest'
import { readDirectoryTree, writeDirectoryTree } from '../directoryCarrier'
import { addReference } from '../refs'
import { removeEntry } from '../tree'
import { MANIFEST_PATH, TRASH_DIR } from '../paths'
import type { EntryContent, WorkspaceTree } from '../types'
import { MemoryDirectory } from '@/stores/documentStore/memoryDirectory'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { fakeDirectory } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// The folder endpoint's on-disk layout: where each payload lands and in what
// order they go down. The round-trip contract covers what comes back out;
// this covers what a user finds in the folder they picked.

function sample(): WorkspaceTree {
  const tree = treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3, 4]), 'application/step'),
  ])
  addReference(tree, 'a', 'b')
  return tree
}

// Every committed file name, in the order the writes landed, shared down the
// tree so a payload in documents/ and the manifest at the root are one sequence.
class RecordingDirectory extends MemoryDirectory {
  order: string[]

  constructor(name: string, order: string[] = []) {
    super(name)
    this.order = order
  }

  protected override beforeWrite(name: string): void {
    this.order.push(name)
  }

  protected override makeChild(name: string): MemoryDirectory {
    return new RecordingDirectory(name, this.order)
  }
}

describe('the folder layout', () => {
  it('writes the manifest, documents and files at their logical paths', async () => {
    const dir = fakeDirectory('cad')
    await writeDirectoryTree(dir, sample())

    expect(dir.fileNames()).toEqual([MANIFEST_PATH])
    const snapshot = dir.snapshot()
    expect(snapshot['documents/A.yaml']).toBe('kind: part\n')
    expect(Object.keys(snapshot)).toContain('files/b.step')
  })

  it('puts a trashed payload under the trash directory, not at its logical path', async () => {
    const dir = fakeDirectory('cad')
    const tree = sample()
    removeEntry(tree, 'a')
    await writeDirectoryTree(dir, tree)

    const paths = Object.keys(dir.snapshot())
    expect(paths).toContain(`${TRASH_DIR}/documents/A.yaml`)
    expect(paths).not.toContain('documents/A.yaml')
  })

  // The manifest is the index, so it goes down last: a write torn before it
  // leaves the old index and the new payloads as orphans, never a manifest
  // naming a path that is not there.
  it('writes every payload before the manifest', async () => {
    const dir = new RecordingDirectory('cad')
    await writeDirectoryTree(dir as unknown as FileSystemDirectoryHandle, sample())

    expect(dir.order).toEqual(['A.yaml', 'b.step', MANIFEST_PATH])
  })

  it('refuses a manifest-less folder rather than reading an empty tree', async () => {
    await expect(readDirectoryTree(fakeDirectory('cad'))).rejects.toThrow(/manifest not found/)
  })

  it('refuses a folder whose manifest names a payload that is gone', async () => {
    const dir = fakeDirectory('cad')
    await writeDirectoryTree(dir, sample())
    await dir.removeEntry('documents')

    await expect(readDirectoryTree(dir)).rejects.toThrow(/payload is missing/)
  })

  // The manifest is the index, so a row it names with no content is a gap to
  // surface, not a blank file smuggled onto the disk.
  it('refuses a tree row with no content', async () => {
    const tree = sample()
    tree.contents.delete('b')
    await expect(writeDirectoryTree(fakeDirectory('cad'), tree))
      .rejects.toThrow('Entry b has no content')
  })

  it('refuses content that carries neither text nor bytes', async () => {
    const tree = sample()
    tree.contents.set('a', {} as EntryContent)
    await expect(writeDirectoryTree(fakeDirectory('cad'), tree))
      .rejects.toThrow('Entry content is empty')
  })

  // An interrupted write must discard the swap file, not commit a partial one.
  it('aborts the in-flight writable and rethrows when a write fails', async () => {
    const abort = vi.fn(async () => {})
    const fileHandle = {
      kind: 'file',
      name: 'A.yaml',
      createWritable: async () => ({ write: async () => { throw new Error('disk full') }, abort, close: async () => {} }),
    }
    const root: { getDirectoryHandle: () => Promise<unknown>; getFileHandle: () => Promise<unknown> } = {
      getDirectoryHandle: async () => root,
      getFileHandle: async () => fileHandle,
    }

    await expect(writeDirectoryTree(root as unknown as FileSystemDirectoryHandle, sample()))
      .rejects.toThrow('disk full')
    expect(abort).toHaveBeenCalledTimes(1)
  })

  // A denied or vanished folder is a different failure from an absent manifest;
  // it must propagate rather than read as "not found".
  it('propagates a non-NotFound filesystem error', async () => {
    const denied = new DOMException('denied', 'NotAllowedError')
    const root: { getDirectoryHandle: () => Promise<unknown>; getFileHandle: () => Promise<unknown> } = {
      getDirectoryHandle: async () => root,
      getFileHandle: async () => { throw denied },
    }

    await expect(readDirectoryTree(root as unknown as FileSystemDirectoryHandle))
      .rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})
