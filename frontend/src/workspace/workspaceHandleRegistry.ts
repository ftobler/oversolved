import { idbGetHandle, idbPutHandle, idbDeleteHandle } from '@/stores/documentStore/idb'
import { hasReadWritePermission, type PermissionedHandle } from '@/adapters/fileSystemAccess'

// Remembering which folder (or zip file) backs which workspace, across sessions.
//
// The single-library registry this replaces kept one folder under one fixed key;
// a workspace grid holds many, so the handle is keyed by the workspace id. The
// rest of the discipline is unchanged: IndexedDB is the only place a
// FileSystemHandle can survive, but the GRANT does not, so a restored handle
// answers 'prompt' until the user re-confirms, and requesting permission throws
// outside a user gesture.
//
// Hence two entry points per handle kind with different rules:
//
//   restore*()  boot, no gesture: probe only, never prompt.
//   reopen*()   a click: may prompt, and forgets a refused handle.
//
// Every path that cannot produce a usable handle returns null, and the caller
// keeps the workspace's IndexedDB working copy with its documents reachable.

function directoryKey(workspace: string): string {
  return `workspace:${workspace}`
}

function zipKey(workspace: string): string {
  return `workspace:${workspace}:zip`
}

async function stored<T>(key: string): Promise<T | null> {
  try {
    return (await idbGetHandle<T>(key)) ?? null
  } catch {
    return null
  }
}

async function remember<T>(key: string, handle: T): Promise<void> {
  try {
    await idbPutHandle(key, handle)
  } catch {
    // A browser that refuses to clone the handle (or has storage disabled) just
    // means the folder is not remembered past this session. The workspace is
    // still open right now, so this must not fail the open.
  }
}

async function reopen<T extends PermissionedHandle>(
  key: string,
  handle: T | null,
): Promise<T | null> {
  if (!handle) return null
  if (await hasReadWritePermission(handle, { request: true })) return handle
  await idbDeleteHandle(key).catch(() => undefined)
  return null
}

export async function rememberWorkspaceHandle(
  workspace: string, handle: FileSystemDirectoryHandle,
): Promise<void> {
  await remember(directoryKey(workspace), handle)
}

export async function forgetWorkspaceHandle(workspace: string): Promise<void> {
  await idbDeleteHandle(directoryKey(workspace)).catch(() => undefined)
}

export async function storedWorkspaceHandle(workspace: string): Promise<FileSystemDirectoryHandle | null> {
  return stored<FileSystemDirectoryHandle>(directoryKey(workspace))
}

// The folder's name without asking for permission, so the grid can name the
// entry it is offering to reopen. Reading `.name` off a handle needs no grant.
export async function workspaceHandleName(workspace: string): Promise<string | null> {
  return (await storedWorkspaceHandle(workspace))?.name ?? null
}

// Boot path. Returns the handle only if the grant is somehow still in force,
// which is the exception rather than the rule: a null here usually means "there
// is a remembered folder, but it needs a click".
export async function restoreWorkspaceHandle(workspace: string): Promise<FileSystemDirectoryHandle | null> {
  const handle = await storedWorkspaceHandle(workspace)
  if (!handle) return null
  return (await hasReadWritePermission(handle, { request: false })) ? handle : null
}

export async function reopenWorkspaceHandle(workspace: string): Promise<FileSystemDirectoryHandle | null> {
  return reopen(directoryKey(workspace), await storedWorkspaceHandle(workspace))
}

export async function rememberWorkspaceZipHandle(
  workspace: string, handle: FileSystemFileHandle,
): Promise<void> {
  await remember(zipKey(workspace), handle)
}

export async function forgetWorkspaceZipHandle(workspace: string): Promise<void> {
  await idbDeleteHandle(zipKey(workspace)).catch(() => undefined)
}

export async function storedWorkspaceZipHandle(workspace: string): Promise<FileSystemFileHandle | null> {
  return stored<FileSystemFileHandle>(zipKey(workspace))
}

export async function restoreWorkspaceZipHandle(workspace: string): Promise<FileSystemFileHandle | null> {
  const handle = await storedWorkspaceZipHandle(workspace)
  if (!handle) return null
  return (await hasReadWritePermission(handle, { request: false })) ? handle : null
}

export async function reopenWorkspaceZipHandle(workspace: string): Promise<FileSystemFileHandle | null> {
  return reopen(zipKey(workspace), await storedWorkspaceZipHandle(workspace))
}
