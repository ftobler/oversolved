import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ManifestEntry, WorkspaceTree } from '../types'
import { IdbWorkspaceStore } from '../store'
import { buildZipBytes } from '../zipCarrier'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// The one source read in the app. The folder/zip handles and the permission
// handshake are browser-only surfaces, so those two seams are mocked and every
// other layer (readBagTree, readZipBag, deserializeTree, IdbWorkspaceStore) runs
// for real against fake-indexeddb.

vi.mock('@/stores/documentStore/idb', async importOriginal => {
  const actual = await importOriginal<typeof import('@/stores/documentStore/idb')>()
  return { ...actual, idbGetHandle: vi.fn(), idbPutHandle: vi.fn() }
})

vi.mock('@/adapters/fileSystemAccess', async importOriginal => {
  const actual = await importOriginal<typeof import('@/adapters/fileSystemAccess')>()
  return { ...actual, hasReadWritePermission: vi.fn() }
})

import {
  getOriginResolver,
  mintOriginLocator,
  registerOriginSource,
  rememberOriginDirectory,
  rememberOriginZip,
  resolveOrigin,
} from '../originResolver'
import { idbGetHandle, idbPutHandle } from '@/stores/documentStore/idb'
import { hasReadWritePermission } from '@/adapters/fileSystemAccess'

const getHandle = vi.mocked(idbGetHandle)
const putHandle = vi.mocked(idbPutHandle)
const permission = vi.mocked(hasReadWritePermission)

function bytesOfText(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function fileHandle(name: string, bytes: Uint8Array): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    getFile: async () => ({ arrayBuffer: async () => bytes.slice().buffer }),
  } as unknown as FileSystemFileHandle
}

function directoryHandle(children: FileSystemHandle[]): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: 'source',
    values: () => {
      let index = 0
      return {
        next: async () => (index < children.length
          ? { value: children[index++], done: false }
          : { value: undefined, done: true }),
        [Symbol.asyncIterator]() { return this },
      }
    },
  } as unknown as FileSystemDirectoryHandle
}

function soleEntry(tree: WorkspaceTree): [string, ManifestEntry] {
  const ids = Object.keys(tree.manifest.entries)
  expect(ids).toHaveLength(1)
  return [ids[0], tree.manifest.entries[ids[0]]]
}

describe('mintOriginLocator', () => {
  it('prefixes the gesture kind and never repeats a locator', () => {
    expect(mintOriginLocator('folder')).toMatch(/^folder:/)
    expect(mintOriginLocator('zip')).toMatch(/^zip:/)
    expect(mintOriginLocator('file')).toMatch(/^file:/)
    expect(mintOriginLocator('folder')).not.toBe(mintOriginLocator('folder'))
  })
})

describe('resolveOrigin', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    getHandle.mockReset()
    putHandle.mockReset()
    permission.mockReset()
  })

  it('reads a registered in-session descriptor whose read resolves', async () => {
    registerOriginSource({
      locator: 'folder:session-ok',
      name: 'source',
      read: async () => ({ items: [{ path: 'A.yaml', bytes: bytesOfText('kind: part\n') }], origin: 'folder:session-ok' }),
    })

    const tree = await resolveOrigin('folder:session-ok')
    expect(tree).not.toBeNull()
    const [id, row] = soleEntry(tree!)
    expect(row).toMatchObject({ kind: 'document', name: 'A', docKind: 'part' })
    expect(tree!.contents.get(id)?.text).toBe('kind: part\n')
  })

  it('resolves null when an in-session read rejects', async () => {
    registerOriginSource({
      locator: 'folder:session-fail',
      read: async () => { throw new Error('offline') },
    })

    expect(await resolveOrigin('folder:session-fail')).toBeNull()
  })

  it('reads a remembered folder handle when the grant is live', async () => {
    const handle = directoryHandle([fileHandle('A.yaml', bytesOfText('kind: part\n'))])
    getHandle.mockResolvedValue(handle)
    permission.mockResolvedValue(true)

    const tree = await resolveOrigin('folder:granted')
    const [, row] = soleEntry(tree!)
    expect(row.name).toBe('A')
    expect(permission).toHaveBeenCalledWith(handle, { request: true })
  })

  it('resolves null for a folder with no remembered handle', async () => {
    getHandle.mockResolvedValue(undefined)

    expect(await resolveOrigin('folder:forgotten')).toBeNull()
    expect(permission).not.toHaveBeenCalled()
  })

  it('resolves null when the folder permission is refused', async () => {
    getHandle.mockResolvedValue(directoryHandle([fileHandle('A.yaml', bytesOfText('kind: part\n'))]))
    permission.mockResolvedValue(false)

    expect(await resolveOrigin('folder:denied')).toBeNull()
  })

  it('resolves null when reading the folder throws', async () => {
    getHandle.mockResolvedValue({
      kind: 'directory',
      name: 'gone',
      values: () => { throw new Error('vanished') },
    } as unknown as FileSystemDirectoryHandle)
    permission.mockResolvedValue(true)

    expect(await resolveOrigin('folder:throwing')).toBeNull()
  })

  it('resolves null when the handle store itself rejects', async () => {
    getHandle.mockRejectedValue(new Error('idb unavailable'))

    expect(await resolveOrigin('folder:broken-store')).toBeNull()
  })

  it('reads a remembered zip handle into a tree', async () => {
    const zipBytes = await buildZipBytes(treeWith([documentEntry('a', 'A', { text: 'kind: part\n# z\n' })], 'src'))
    getHandle.mockResolvedValue(fileHandle('src.zip', zipBytes))
    permission.mockResolvedValue(true)

    const tree = await resolveOrigin('zip:granted')
    expect(tree).not.toBeNull()
    expect(tree!.manifest.entries.a.name).toBe('A')
    expect(tree!.contents.get('a')?.text).toBe('kind: part\n# z\n')
  })

  it('resolves null when the zip getFile throws', async () => {
    getHandle.mockResolvedValue({
      kind: 'file',
      name: 'gone.zip',
      getFile: async () => { throw new Error('removed') },
    } as unknown as FileSystemFileHandle)
    permission.mockResolvedValue(true)

    expect(await resolveOrigin('zip:throwing')).toBeNull()
  })

  it('resolves null for a zip with no remembered handle or a refused grant', async () => {
    getHandle.mockResolvedValue(undefined)
    expect(await resolveOrigin('zip:forgotten')).toBeNull()

    getHandle.mockResolvedValue(fileHandle('bad.zip', new Uint8Array([1, 2, 3])))
    permission.mockResolvedValue(false)
    expect(await resolveOrigin('zip:denied')).toBeNull()
  })

  it('resolves null when the remembered bytes are not a zip', async () => {
    getHandle.mockResolvedValue(fileHandle('garbage.zip', new Uint8Array([1, 2, 3, 4])))
    permission.mockResolvedValue(true)

    expect(await resolveOrigin('zip:garbage')).toBeNull()
  })

  it('opens a workspace locator and materializes its lazy file bytes', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    await store.addEntry(workspace, {
      id: 'f1', kind: 'file', name: 'part.step', mime: 'application/step', fileKind: 'step', bytes: new Uint8Array([7, 8, 9]),
    })

    const tree = await resolveOrigin(`workspace:${workspace}`)
    expect(tree).not.toBeNull()
    expect(tree!.contents.get('f1')?.bytes).toEqual(new Uint8Array([7, 8, 9]))
  })

  it('resolves null for an unknown workspace and an unknown locator shape', async () => {
    expect(await resolveOrigin('workspace:no-such-workspace')).toBeNull()
    expect(await resolveOrigin('file:loose')).toBeNull()
  })

  it('does not treat a registration without a read as resolvable', async () => {
    registerOriginSource({ locator: 'folder:no-read', name: 'source' })

    expect(await resolveOrigin('folder:no-read')).toBeNull()
  })

  it('getOriginResolver wires register and resolve to the same registry', async () => {
    const resolver = getOriginResolver()
    resolver.register({
      locator: 'zip:via-api',
      read: async () => ({ items: [{ path: 'A.yaml', bytes: bytesOfText('kind: assembly\n') }], origin: 'zip:via-api' }),
    })

    const tree = await resolver.resolve('zip:via-api')
    expect(tree).not.toBeNull()
    expect(soleEntry(tree!)[1].docKind).toBe('assembly')
  })
})

describe('the origin-keyed handle store', () => {
  beforeEach(() => {
    putHandle.mockReset()
  })

  it('writes a directory handle under origin:<locator>', async () => {
    const handle = directoryHandle([])

    await rememberOriginDirectory('folder:keep', handle)
    expect(putHandle).toHaveBeenCalledTimes(1)
    expect(putHandle).toHaveBeenCalledWith('origin:folder:keep', handle)
  })

  it('writes a zip handle under origin:<locator>:zip', async () => {
    const handle = fileHandle('keep.zip', new Uint8Array([1]))

    await rememberOriginZip('zip:keep', handle)
    expect(putHandle).toHaveBeenCalledTimes(1)
    expect(putHandle).toHaveBeenCalledWith('origin:zip:keep:zip', handle)
  })

  it('swallows a handle the browser refuses to clone', async () => {
    putHandle.mockRejectedValue(new Error('not cloneable'))

    await expect(rememberOriginDirectory('folder:uncloneable', directoryHandle([]))).resolves.toBeUndefined()
  })
})
