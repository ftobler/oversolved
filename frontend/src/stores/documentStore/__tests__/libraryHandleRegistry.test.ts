import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetFakeIndexedDb } from './fakeIndexedDb'
import { resetDbConnection } from '../idb'
import {
  rememberLibraryHandle, restoreLibraryHandle, reopenLibraryHandle,
  rememberedLibraryName, forgetLibraryHandle,
} from '../libraryHandleRegistry'

// A real FileSystemDirectoryHandle is a platform object: IndexedDB clones it
// with its methods intact, which is the whole reason a handle can be persisted
// at all. fake-indexeddb's structured clone keeps only plain data, so a stub
// carrying its own queryPermission would come back out stripped and every
// permission branch would collapse to "granted".
//
// So the permission handshake is mocked at its module boundary and the stub
// carries a plain `permission` field the mock reads back off the CLONED handle.
// The handshake itself is contracted in adapters/__tests__/fileSystemAccess.
const prompted = vi.fn()

vi.mock('@/adapters/fileSystemAccess', () => ({
  hasReadWritePermission: async (
    handle: { permission?: PermissionState; onRequest?: PermissionState },
    { request }: { request: boolean },
  ) => {
    // A vanished directory reads as "no permission", which is what the real
    // implementation returns for it (it swallows the NotFoundError itself).
    if (handle.permission === undefined) return false
    if (handle.permission === 'granted') return true
    if (!request || handle.permission === 'denied') return false
    prompted(handle)
    return handle.onRequest === 'granted'
  },
}))

function directory(permission?: PermissionState, onRequest?: PermissionState) {
  return { name: 'cad', permission, onRequest } as unknown as FileSystemDirectoryHandle
}

describe('libraryHandleRegistry', () => {
  beforeEach(() => {
    resetFakeIndexedDb()
    resetDbConnection()
    prompted.mockClear()
  })

  it('reports no remembered library on a first visit', async () => {
    expect(await rememberedLibraryName()).toBeNull()
    expect(await restoreLibraryHandle()).toBeNull()
    expect(await reopenLibraryHandle()).toBeNull()
  })

  it('remembers a folder across a simulated reload', async () => {
    await rememberLibraryHandle(directory('granted'))
    resetDbConnection()  // a new session against the same database
    expect(await rememberedLibraryName()).toBe('cad')
    expect((await restoreLibraryHandle())?.name).toBe('cad')
  })

  // The handle survives; the GRANT does not. Boot runs outside a user gesture,
  // where requestPermission throws, so the probe must answer null and leave the
  // asking to the click that follows.
  it('does not prompt at boot for a handle whose grant lapsed', async () => {
    await rememberLibraryHandle(directory('prompt', 'granted'))
    resetDbConnection()
    expect(await restoreLibraryHandle()).toBeNull()
    expect(prompted).not.toHaveBeenCalled()
    // Still remembered: the sidebar can offer to reopen it.
    expect(await rememberedLibraryName()).toBe('cad')
  })

  it('re-grants on the user gesture path', async () => {
    await rememberLibraryHandle(directory('prompt', 'granted'))
    resetDbConnection()
    expect((await reopenLibraryHandle())?.name).toBe('cad')
    expect(prompted).toHaveBeenCalledTimes(1)
  })

  // A refusal must not leave a dead folder entry sitting in the sidebar forever.
  it('forgets a handle whose re-permission was refused', async () => {
    await rememberLibraryHandle(directory('prompt', 'denied'))
    resetDbConnection()
    expect(await reopenLibraryHandle()).toBeNull()
    expect(await rememberedLibraryName()).toBeNull()
  })

  it('forgets a directory that no longer exists', async () => {
    await rememberLibraryHandle(directory(undefined))  // no permission to be had
    resetDbConnection()
    expect(await reopenLibraryHandle()).toBeNull()
    expect(await rememberedLibraryName()).toBeNull()
  })

  it('forgets on request', async () => {
    await rememberLibraryHandle(directory('granted'))
    await forgetLibraryHandle()
    expect(await rememberedLibraryName()).toBeNull()
  })

  // Not being able to remember the folder is not a reason to fail opening it:
  // the library the user just picked works for this session either way.
  it('does not throw when the handle cannot be stored', async () => {
    const uncloneable = { name: 'cad', fn: () => undefined }
    await expect(
      rememberLibraryHandle(uncloneable as unknown as FileSystemDirectoryHandle),
    ).resolves.toBeUndefined()
  })
})
