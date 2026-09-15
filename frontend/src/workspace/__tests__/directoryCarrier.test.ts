import { describe, it, expect } from 'vitest'
import { readDirectoryTree, writeDirectoryTree } from '../directoryCarrier'
import { addReference } from '../refs'
import { removeEntry } from '../tree'
import { MANIFEST_PATH, TRASH_DIR } from '../paths'
import type { WorkspaceTree } from '../types'
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
})
