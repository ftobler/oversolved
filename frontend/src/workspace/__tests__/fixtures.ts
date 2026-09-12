import type { WorkspaceEntry, WorkspaceTree } from '..'
import { createTree, emptyManifest, putEntry } from '..'

// A workspace tree built from entries in the order given. Paths come from
// pathFor, so tests assert against the same naming the product uses.
export function treeWith(entries: WorkspaceEntry[], workspace = 'ws-1'): WorkspaceTree {
  const tree = createTree(emptyManifest(workspace))
  for (const entry of entries) putEntry(tree, entry)
  return tree
}

export function documentEntry(
  id: string,
  name: string,
  options: { text?: string; docKind?: string } = {},
): WorkspaceEntry {
  return {
    id,
    kind: 'document',
    name,
    docKind: options.docKind ?? 'part',
    text: options.text ?? 'kind: part\n',
  }
}

export function fileEntry(id: string, name: string, bytes: Uint8Array, mime = 'application/octet-stream'): WorkspaceEntry {
  return { id, kind: 'file', name, mime, bytes }
}

export function bytesOf(values: number[]): Uint8Array {
  return new Uint8Array(values)
}
