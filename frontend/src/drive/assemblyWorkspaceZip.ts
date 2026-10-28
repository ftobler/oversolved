// The `.zip` hand-off: an assembly plus every part it binds and every file a
// part references, written as a workspace archive. The user imports it into the
// browser (the server never writes the user's IndexedDB), so the ids in the
// archive are the doc_ids the assembly already names: the import path keeps
// them when it lands a new workspace, and every `part_instance.doc_id` resolves
// to a live part entry.

import { stringify as stringifyYaml } from 'yaml'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import type { WorkspaceTree } from '@/workspace/types'
import { emptyManifest } from '@/workspace/manifest'
import { createTree, addEntry } from '@/workspace/tree'
import { addReference } from '@/workspace/refs'
import { extractReferenceIds } from '@/workspace/import'
import { buildZipBytes } from '@/workspace/zipCarrier'
import { randomUuid } from '@/utils/randomUuid'

export interface AssemblyZipInput {
  doc: AssemblyDoc
  parts: Record<string, PartDoc>
  // STEP bytes a part's import_step features need, keyed by file_id.
  files?: ReadonlyMap<string, Uint8Array>
}

/**
 * Build the workspace tree for an assembly: the assembly document, one part
 * document per bound doc_id, one file entry per referenced file, and a
 * reference edge wherever a document's text names another entry.
 */
export function buildAssemblyWorkspaceTree(input: AssemblyZipInput): WorkspaceTree {
  const tree = createTree(emptyManifest(randomUuid()))
  const assemblyId = randomUuid()
  addEntry(tree, {
    id: assemblyId,
    kind: 'document',
    name: 'assembly',
    docKind: 'assembly',
    text: stringifyYaml(input.doc),
  })
  for (const [docId, partDoc] of Object.entries(input.parts)) {
    addEntry(tree, {
      id: docId,
      kind: 'document',
      name: docId,
      docKind: 'part',
      text: stringifyYaml(partDoc),
    })
  }
  for (const [fileId, bytes] of input.files ?? new Map<string, Uint8Array>()) {
    addEntry(tree, {
      id: fileId,
      kind: 'file',
      name: fileId,
      mime: 'application/octet-stream',
      bytes: new Uint8Array(bytes),
    })
  }
  // The text is the only place an id reference lives, so read it back through
  // the import path's own extractor: the archive's edges are exactly the ones
  // an import would discover.
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'document') continue
    const text = tree.contents.get(id)?.text ?? ''
    for (const ref of extractReferenceIds(text)) {
      if (tree.manifest.entries[ref] !== undefined) addReference(tree, id, ref)
    }
  }
  return tree
}

/** The zip bytes for an assembly workspace hand-off. */
export function buildAssemblyWorkspaceZip(input: AssemblyZipInput): Promise<Uint8Array> {
  return buildZipBytes(buildAssemblyWorkspaceTree(input))
}
