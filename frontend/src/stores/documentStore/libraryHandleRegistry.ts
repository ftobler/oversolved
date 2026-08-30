import { idbGetHandle, idbPutHandle, idbDeleteHandle } from './idb'
import { hasReadWritePermission } from '@/adapters/fileSystemAccess'

// Remembering which folder is the library, across sessions.
//
// This is the role IndexedDB takes on once a document can live in a real file.
// A FileSystemDirectoryHandle is structured-cloneable, so IndexedDB is the only
// place it CAN be kept -- but what survives is the HANDLE, not the GRANT. The
// browser drops write permission when the tab closes, so a restored handle
// answers 'prompt' until the user re-confirms, and `requestPermission` throws
// outside a user gesture.
//
// Hence two entry points with different rules:
//
//   restoreLibraryHandle()  boot, no gesture: probe only, never prompt.
//   reopenLibraryHandle()   a click: may prompt, and forgets a refused handle.
//
// Every path that cannot produce a usable handle returns null, and the caller
// falls back to the browser-storage library with the user's documents still
// reachable. Losing a folder is never allowed to lose the app.

const HANDLE_KEY = 'library-directory'

export async function rememberLibraryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await idbPutHandle(HANDLE_KEY, handle)
  } catch {
    // A browser that refuses to clone the handle (or has storage disabled) just
    // means the folder is not remembered past this session. The library the
    // user opened still works right now, so this must not fail the open.
  }
}

export async function forgetLibraryHandle(): Promise<void> {
  await idbDeleteHandle(HANDLE_KEY).catch(() => undefined)
}

async function storedHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await idbGetHandle<FileSystemDirectoryHandle>(HANDLE_KEY)) ?? null
  } catch {
    return null
  }
}

// Boot path. Returns the handle only if the grant is somehow still in force,
// which is the exception rather than the rule -- so a null here usually means
// "there is a remembered folder, but it needs a click", not "there is none".
// Use `hasRememberedLibrary()` to tell those apart.
export async function restoreLibraryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await storedHandle()
  if (!handle) return null
  return (await hasReadWritePermission(handle, { request: false })) ? handle : null
}

export async function hasRememberedLibrary(): Promise<boolean> {
  return (await storedHandle()) !== null
}

// User-gesture path: prompts if needed. A refusal, a revoked grant or a
// directory that no longer exists all end the same way -- the handle is
// forgotten, so the app stops offering a folder it cannot open, and the next
// boot presents browser storage without a dead entry beside it.
export async function reopenLibraryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await storedHandle()
  if (!handle) return null
  if (await hasReadWritePermission(handle, { request: true })) return handle
  await forgetLibraryHandle()
  return null
}
