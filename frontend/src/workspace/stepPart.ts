// Import a STEP file into a workspace as the part document that owns it. This
// is the assembly gesture's workspace half: adoption (workspace/import.ts) lands
// a STEP plus a part for a whole bag, while this adds the same pair to an open
// workspace and hands back the ids the caller instances.
//
// The bytes live once. A file entry is keyed by its content hash, so a second
// import of the same STEP reuses the stored bytes; a part document is keyed by
// (that file, the requested name), so importing the same file under the same
// name is idempotent and a different name is a second view of the same body.

import type { WorkspaceEntry, WorkspaceTree } from './types'
import { addEntry } from './tree'
import { addReference } from './refs'
import { hashRecord } from './contentHash'
import { getWorkspaceStore, type WorkspaceStore } from './store'
import { buildStepContent } from '@/stores/documentStore/stepImport'
import { uniqueStem } from '@/stores/documentStore/secureFilename'
import { stemOf } from './import'
import { randomId } from '@/utils/yamlMutations'
import { randomUuid } from '@/utils/randomUuid'

export interface StepPartOptions {
  // The picked file's name, kept on the file entry and used for the default
  // part name and the import_step label.
  fileName?: string
  // The part document's display name; defaults to the file's stem.
  name?: string
}

export interface StepPartImport {
  partId: string
  fileId: string
  // The name the part document carries: the requested one, or its collision
  // suffix when that name was taken.
  name: string
  // True when this exact file and name were already imported, so nothing was
  // written and partId names the existing document.
  reused: boolean
}

const STEP_MIME = 'application/step'
const STEP_FILE_KIND = 'step'
const DEFAULT_FILE_NAME = 'import.step'
const DEFAULT_PART_NAME = 'Imported part'

/**
 * Add a STEP file and its part document to `workspace`, or find the pair a
 * previous import of the same bytes under the same name left. One save writes
 * both entries and the part-to-file edge, so the pair cannot half-exist; a
 * repeat import is a read, not a second copy.
 */
export async function addStepPart(
  workspace: string,
  bytes: Uint8Array,
  opts: StepPartOptions = {},
  store: WorkspaceStore = getWorkspaceStore(),
): Promise<StepPartImport> {
  if (bytes.byteLength === 0) throw new Error('STEP file is empty')
  const fileName = opts.fileName?.trim() || DEFAULT_FILE_NAME
  const requestedName = opts.name?.trim() || stemOf(fileName) || DEFAULT_PART_NAME
  const opened = await store.open(workspace)
  const tree = opened.tree
  const fileId = await findStepFile(workspace, bytes, store) ?? randomUuid()
  const existing = findStepPart(tree, fileId, requestedName)
  if (existing !== undefined) return { partId: existing, fileId, name: requestedName, reused: true }

  const name = uniqueDocumentName(requestedName, tree)
  if (tree.manifest.entries[fileId] === undefined) {
    addStepFile(tree, fileId, fileName, bytes)
  }
  const partId = randomUuid()
  addEntry(tree, {
    id: partId,
    kind: 'document',
    name,
    docKind: 'part',
    text: buildStepContent(fileId, randomId(18), fileName),
  })
  // The edge is what makes the part reachable from the workspace: the delete
  // guard and the assembly bundle key both read it.
  addReference(tree, partId, fileId)
  await store.save(workspace, tree)
  return { partId, fileId, name, reused: false }
}

function addStepFile(tree: WorkspaceTree, id: string, fileName: string, bytes: Uint8Array): void {
  const entry: WorkspaceEntry = {
    id,
    kind: 'file',
    name: fileName,
    mime: STEP_MIME,
    fileKind: STEP_FILE_KIND,
    bytes: new Uint8Array(bytes),
  }
  addEntry(tree, entry)
}

// The stored STEP file entry with these bytes, or undefined. Content-addressed
// so a re-import never duplicates a large payload. The lookup reads the
// payload-free listing: an opened tree leaves file bytes lazy, so the stored
// content hash is the only way to compare them without loading every file.
async function findStepFile(workspace: string, bytes: Uint8Array, store: WorkspaceStore): Promise<string | undefined> {
  const contentHash = hashRecord({ kind: 'file', bytes })
  for (const meta of await store.listEntries(workspace)) {
    if (meta.kind !== 'file' || meta.fileKind !== STEP_FILE_KIND) continue
    if (meta.contentHash !== undefined) {
      if (meta.contentHash === contentHash) return meta.id
      continue
    }
    // A carrier that does not track hashes (the in-memory conformer) can only
    // answer by reading the payload.
    const entry = await store.readEntry(workspace, meta.id)
    if (entry.bytes !== undefined && hashRecord({ kind: 'file', bytes: entry.bytes }) === contentHash) return meta.id
  }
  return undefined
}

// A part document that already imports this file under this display name.
function findStepPart(tree: WorkspaceTree, fileId: string, name: string): string | undefined {
  for (const [id, targets] of Object.entries(tree.manifest.references)) {
    if (!targets.includes(fileId)) continue
    const row = tree.manifest.entries[id]
    if (row?.kind === 'document' && row.docKind === 'part' && row.name === name) return id
  }
  return undefined
}

// Display names colliding are suffixed like paths are (Bracket, Bracket_1), so
// two documents never read the same in the workspace list.
function uniqueDocumentName(base: string, tree: WorkspaceTree): string {
  const taken = new Set(
    Object.values(tree.manifest.entries)
      .filter(row => row.kind === 'document')
      .map(row => row.name),
  )
  return uniqueStem(base, candidate => taken.has(candidate))
}
