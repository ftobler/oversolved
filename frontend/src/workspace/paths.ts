import type { EntryKind } from './types'
import { secureFilename, uniqueStem, UNTITLED_DOC_NAME } from '@/stores/documentStore/secureFilename'

export const FORMAT_VERSION = 1
export const MANIFEST_PATH = '.oversolved-manifest.yaml'
export const DOCUMENTS_DIR = 'documents'
export const FILES_DIR = 'files'
// The folder layout's physical home for trashed payloads. It is not part of the
// logical tree: the manifest's trash list owns identity, and an archive writes
// trashed payloads at their logical path instead. A folder read therefore
// resolves a payload at the logical path first and here second.
export const TRASH_DIR = '.oversolved-trash'
// `.oversolved-index.json` is the old folder library's index and stays reserved
// but unused so it can never be mistaken for a workspace manifest.
export const RESERVED_PREFIX = '.oversolved-'

export function kindDir(kind: EntryKind): string {
  return kind === 'document' ? DOCUMENTS_DIR : FILES_DIR
}

// The display name to a reserved-dir-relative path. `taken` answers for the
// full candidate path, which is what scopes collision suffixes per directory.
export function pathFor(
  kind: EntryKind,
  name: string,
  taken: (path: string) => boolean,
  dir: string = kindDir(kind),
): string {
  const base = secureFilename(name) || UNTITLED_DOC_NAME
  const ext = kind === 'document' ? '.yaml' : ''
  const prefix = dir ? `${dir.replace(/\/+$/, '')}/` : ''
  const stem = uniqueStem(base, candidate => taken(`${prefix}${candidate}${ext}`))
  return `${prefix}${stem}${ext}`
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

// The manifest itself is the one reserved name the tree is allowed to hold;
// every other `.oversolved-*` segment is app bookkeeping and cannot be an entry.
export function isReservedPath(path: string): boolean {
  if (path === MANIFEST_PATH) return false
  return path.split('/').some(segment => segment.startsWith(RESERVED_PREFIX))
}

export function assertPathFree(path: string, isTaken: (path: string) => boolean): void {
  if (isReservedPath(path)) throw new Error(`Path is reserved: ${path}`)
  if (isTaken(path)) throw new Error(`Path already in use: ${path}`)
}
