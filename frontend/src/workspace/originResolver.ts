import type { WorkspaceTree } from './types'
import { readBagTree, readDirectoryBag, readZipBag, type ImportBag } from './import'
import { getWorkspaceStore } from './store'
import { idbGetHandle, idbPutHandle } from '@/stores/documentStore/idb'
import { hasReadWritePermission, type PermissionedHandle } from '@/adapters/fileSystemAccess'
import { randomUuid } from '@/utils/randomUuid'

// A source a copy came from, named by the gesture that made the copy. Only the
// gesture knows the folder handle, archive handle or source workspace id, so
// the descriptor is threaded from there rather than read off the bag (a bag is
// (path, bytes) by construction and drops the source's identity). `read` is a
// same-session closure and is never serialized; a descriptor without one can
// still resolve from a remembered handle or a live workspace.
export interface OriginDescriptor {
  locator: string  // opaque per-gesture key, stored on the provenance record
  name?: string  // the source's display name, kept apart from the locator
  workspace?: string  // source workspace id, when the source carries one
  read?: () => Promise<ImportBag>  // re-reads the source in this session
}

// A locator is minted once per gesture and is what the in-session registry and
// the durable handle store key on. The display name alone cannot key them: two
// folders both named `cad` would share a key and the second would overwrite the
// first's handle, so updating one would pull the other's bytes.
export function mintOriginLocator(kind: 'folder' | 'zip' | 'file'): string {
  return `${kind}:${randomUuid()}`
}

export interface OriginResolver {
  register(source: OriginDescriptor): void
  resolve(locator: string): Promise<WorkspaceTree | null>
}

// The in-session descriptors, keyed by locator. Registering is what lets the
// update gesture resolve a source it just picked without a handle round trip.
const registered = new Map<string, OriginDescriptor>()

export function registerOriginSource(source: OriginDescriptor): void {
  registered.set(source.locator, source)
}

// The one source read in the whole app, and the seam I2 spies on. Folder, zip
// and file sources go through the same classifier (`readBagTree`) the import
// gesture used, so the entry ids a later read produces match the ones stamped
// at copy time. Anything unknown, offline, renamed or purged resolves to null,
// the neutral unreachable state; a caller must not turn null into an error.
export async function resolveOrigin(locator: string): Promise<WorkspaceTree | null> {
  const inSession = registered.get(locator)
  if (inSession?.read) {
    try {
      return readBagTree(await inSession.read()).tree
    } catch {
      return null
    }
  }
  if (locator.startsWith('folder:')) {
    const handle = await reopenOriginDirectory(locator)
    if (!handle) return null
    try {
      return readBagTree(await readDirectoryBag(handle, locator)).tree
    } catch {
      return null
    }
  }
  if (locator.startsWith('zip:')) {
    const handle = await reopenOriginZip(locator)
    if (!handle) return null
    return readOriginZipTree(handle, locator)
  }
  if (locator.startsWith('workspace:')) {
    try {
      return await openWorkspaceTree(locator.slice('workspace:'.length))
    } catch {
      return null
    }
  }
  return null
}

export function getOriginResolver(): OriginResolver {
  return { register: registerOriginSource, resolve: resolveOrigin }
}

async function readOriginZipTree(
  handle: FileSystemFileHandle, locator: string,
): Promise<WorkspaceTree | null> {
  try {
    const file = await handle.getFile()
    const bytes = new Uint8Array(await file.arrayBuffer())
    return readBagTree(await readZipBag(bytes, locator)).tree
  } catch {
    return null
  }
}

// A workspace source opens with its file bytes lazy, so materialize them before
// the update path copies content verbatim. Not produced by a C6 gesture yet,
// but the locator form is reserved and this keeps it honest.
async function openWorkspaceTree(workspace: string): Promise<WorkspaceTree> {
  const store = getWorkspaceStore()
  const opened = await store.open(workspace)
  for (const [id, row] of Object.entries(opened.tree.manifest.entries)) {
    if (row.kind !== 'file' || opened.tree.contents.has(id)) continue
    const file = await store.readEntry(workspace, id)
    opened.tree.contents.set(id, { bytes: new Uint8Array(file.bytes ?? new Uint8Array(0)) })
  }
  return opened.tree
}

// ─── the origin-keyed handle store ───

// The workspace handle registry is keyed by workspace; an origin needs the same
// restore/reopen discipline under an origin: key. IndexedDB is the only place a
// handle survives a session, and the grant does not, so a restored handle is
// re-confirmed at the explicit update gesture (the only caller of resolveOrigin
// for a handle-backed locator).

function directoryKey(locator: string): string {
  return `origin:${locator}`
}

function zipKey(locator: string): string {
  return `origin:${locator}:zip`
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
    // A handle the browser refuses to clone only means the origin is
    // same-session. The in-session descriptor still resolves it now.
  }
}

export async function rememberOriginDirectory(
  locator: string, handle: FileSystemDirectoryHandle,
): Promise<void> {
  await remember(directoryKey(locator), handle)
}

export async function rememberOriginZip(
  locator: string, handle: FileSystemFileHandle,
): Promise<void> {
  await remember(zipKey(locator), handle)
}

async function reopenOriginDirectory(locator: string): Promise<FileSystemDirectoryHandle | null> {
  const handle = await stored<FileSystemDirectoryHandle>(directoryKey(locator))
  if (!handle) return null
  const permitted = await hasReadWritePermission(handle as PermissionedHandle, { request: true })
  return permitted ? handle : null
}

async function reopenOriginZip(locator: string): Promise<FileSystemFileHandle | null> {
  const handle = await stored<FileSystemFileHandle>(zipKey(locator))
  if (!handle) return null
  const permitted = await hasReadWritePermission(handle as PermissionedHandle, { request: true })
  return permitted ? handle : null
}
