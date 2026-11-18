// Import a STEP file into a workspace as the part document that owns it, and,
// when the import asked for an assembly, as an assembly holding that part or
// one part per solid. This is the assembly gesture's workspace half: adoption
// (workspace/import.ts) lands a STEP plus a part for a whole bag, while this
// adds the same pair to an open workspace and hands back the ids the caller
// instances.
//
// The bytes live once. A file entry is looked up by its content hash, so a
// second import of the same STEP reuses the stored bytes; a part document is
// looked up by (that file, the requested name), so importing the same file
// under the same name is idempotent and a different name is a second view of
// the same body.
//
// A split import never registers the whole file's body and then re-uses it: the
// kernel writes each solid to its own STEP bytes (occ/stepSplit.ts), and each
// part imports its own small file through the ordinary import_step leaf. That
// keeps every split part an ordinary STEP part and avoids N full parses of the
// source file per solve.

import { stringify as stringifyYaml } from 'yaml'
import type { EntryMeta, WorkspaceEntry, WorkspaceTree } from './types'
import { addEntry, putEntry } from './tree'
import { addReference } from './refs'
import { hashRecord } from './contentHash'
import { getWorkspaceStore, type WorkspaceStore } from './store'
import { buildStepContent } from '@/stores/documentStore/stepImport'
import { uniqueStem } from '@/stores/documentStore/secureFilename'
import { stemOf } from './import'
import type { StepImportMode } from './stepImportMode'
import { randomId } from '@/utils/yamlMutations'
import { randomUuid } from '@/utils/randomUuid'
import { appendPartInstance, emptyAssemblyDoc } from '@/utils/assemblyMutations'

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

export interface StepAssemblyOptions {
  // The picked file's name and the stem every minted name derives from.
  fileName?: string
  // B1 or B2. Mode A never reaches this writer: it is adoption's own path.
  mode: Exclude<StepImportMode, 'part'>
  // The per-solid STEP bytes, in splitSolids order, for `assembly_split`. A
  // one-solid list is imported as the original bytes, so it yields exactly B1.
  solids?: readonly Uint8Array[]
  // The assembly's display name; defaults to the file's stem.
  name?: string
  // Fill this existing document row instead of adding one. A workspace picked
  // from the library `create`s a seed document row; the import writes the
  // assembly into it so the new workspace holds one assembly, not an empty
  // document beside one.
  assemblyId?: string
  // The assembly already exists in the editor. Only the parts land here; the
  // caller adds their instances, and the next document save derives the
  // assembly-to-part edges from its own text.
  intoAssembly?: string
}

// One part the import wrote, in the order the caller should instance it.
export interface StepAssemblyPart {
  id: string
  name: string
  fileId: string
}

export interface StepAssemblyImport {
  assemblyId: string
  // The new assembly's display name; absent when the caller supplied one.
  name?: string
  parts: StepAssemblyPart[]
  // The file entries the parts import, deduped by content. A repeated solid
  // shares one entry but still gets a part document each.
  fileIds: string[]
}

// The one wording for a file that split mode cannot use. The caller reports it
// and offers mode A, so it names the way out rather than the fault.
export const STEP_NO_SOLIDS = 'this STEP file has no solids to split; import it as one part'

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
  const ctx = await stepWrite(opened.tree, workspace, store)
  const fileId = await ensureStepFile(ctx, bytes, fileName)
  const existing = findStepPart(ctx.tree, fileId, requestedName)
  if (existing !== undefined) {
    const name = ctx.tree.manifest.entries[existing]?.name ?? requestedName
    return { partId: existing, fileId, name, reused: true }
  }

  const part = await ensureStepPart(ctx, fileId, requestedName, fileName)
  await store.save(workspace, ctx.tree)
  return { partId: part.id, fileId, name: part.name, reused: false }
}

/**
 * Add a STEP import as an assembly: B1 places the whole file's part, B2 places
 * one part per solid. The assembly and every part it names land in one save, so
 * the triple (file, parts, assembly) cannot half-exist. Returns the ids the
 * caller opens or instances.
 */
export async function addStepAssembly(
  workspace: string,
  bytes: Uint8Array,
  opts: StepAssemblyOptions,
  store: WorkspaceStore = getWorkspaceStore(),
): Promise<StepAssemblyImport> {
  if (bytes.byteLength === 0) throw new Error('STEP file is empty')
  const fileName = opts.fileName?.trim() || DEFAULT_FILE_NAME
  const stem = opts.name?.trim() || stemOf(fileName) || DEFAULT_PART_NAME
  const solids = opts.mode === 'assembly_split' ? (opts.solids ?? []) : null
  if (solids !== null && solids.length === 0) throw new Error(STEP_NO_SOLIDS)
  // A one-solid split is B1 exactly, and importing the original bytes is what
  // keeps its body and face names, and their UUIDs, the same as modes A and B1.
  const perSolid = solids !== null && solids.length > 1 ? solids : null

  const opened = await store.open(workspace)
  const ctx = await stepWrite(opened.tree, workspace, store)
  const seed = opts.assemblyId === undefined ? undefined : ctx.tree.manifest.entries[opts.assemblyId]
  const reuseSeed = opts.assemblyId !== undefined && seed?.kind === 'document'
  // The assembly takes the file's stem: the file names both the assembly and
  // the part it holds, and each row states its kind, so the pair reads as one
  // import rather than as `bracket` holding `bracket_1`. Two documents of the
  // SAME kind are still suffixed (Bracket, Bracket_1) so the list stays
  // unambiguous within a kind. A fresh workspace's seed row is the assembly
  // itself, so it takes the stem without consulting the name it carried.
  const assemblyName = opts.intoAssembly !== undefined || reuseSeed
    ? stem
    : uniqueDocumentName(stem, ctx.tree, 'assembly')
  const parts: StepAssemblyPart[] = []
  const fileIds: string[] = []
  if (perSolid === null) {
    const fileId = await ensureStepFile(ctx, bytes, fileName)
    fileIds.push(fileId)
    parts.push(await ensureStepPart(ctx, fileId, stem, fileName))
  } else {
    // Padded to the count's width, so a two-digit split sorts in the workspace
    // list in the same order as the solids it came from.
    const width = String(perSolid.length).length
    for (const [index, solid] of perSolid.entries()) {
      const solidName = `${stem}_${String(index + 1).padStart(width, '0')}`
      const fileId = await ensureStepFile(ctx, solid, `${solidName}.step`)
      fileIds.push(fileId)
      parts.push(await ensureStepPart(ctx, fileId, solidName, `${solidName}.step`))
    }
  }

  if (opts.intoAssembly !== undefined) {
    // The open assembly is the caller's document: no assembly row is written
    // here, and no edge either. The next document save derives the
    // assembly-to-part edges from the instances it carries (store.adoptFiles).
    await store.save(workspace, ctx.tree)
    return { assemblyId: opts.intoAssembly, parts, fileIds }
  }

  const seedRow = opts.assemblyId === undefined ? undefined : ctx.tree.manifest.entries[opts.assemblyId]
  const seedIsDocument = opts.assemblyId !== undefined && seedRow?.kind === 'document'
  const assemblyId = seedIsDocument ? opts.assemblyId! : randomUuid()
  let doc = emptyAssemblyDoc()
  parts.forEach((part, index) => {
    // The first instance anchors the assembly; the rest are free and, with no
    // mates, keep the seed pose the split bytes already place them at.
    doc = appendPartInstance(doc, part.id, 0, index === 0 ? { fixed: true } : {})
  })
  const entry: WorkspaceEntry = {
    id: assemblyId,
    kind: 'document',
    name: assemblyName,
    docKind: 'assembly',
    text: stringifyYaml(doc),
  }
  if (seedIsDocument) putEntry(ctx.tree, entry)
  else addEntry(ctx.tree, entry)
  for (const part of parts) addReference(ctx.tree, assemblyId, part.id)
  await store.save(workspace, ctx.tree)
  return { assemblyId, name: assemblyName, parts, fileIds }
}

// The state one import write runs against: the opened tree, the payload-free
// listing a content-hash lookup reads, and the files this call already wrote
// (a tree is not saved until the end, so a repeated solid cannot find its own
// file entry through the store yet).
interface StepWrite {
  workspace: string
  store: WorkspaceStore
  tree: WorkspaceTree
  metas: EntryMeta[]
  written: Map<string, string>
}

async function stepWrite(tree: WorkspaceTree, workspace: string, store: WorkspaceStore): Promise<StepWrite> {
  return { workspace, store, tree, metas: await store.listEntries(workspace), written: new Map() }
}

// The stored STEP file entry with these bytes, writing the entry when there is
// none. Content-addressed so a re-import never duplicates a large payload.
async function ensureStepFile(ctx: StepWrite, bytes: Uint8Array, fileName: string): Promise<string> {
  const contentHash = hashRecord({ kind: 'file', bytes })
  const written = ctx.written.get(contentHash)
  if (written !== undefined) return written
  const fileId = await findStepFile(ctx.workspace, bytes, ctx.store, ctx.metas) ?? randomUuid()
  if (ctx.tree.manifest.entries[fileId] === undefined) addStepFile(ctx.tree, fileId, fileName, bytes)
  ctx.written.set(contentHash, fileId)
  return fileId
}

// The part document importing `fileId` under `requestedName`: the existing one,
// or a fresh document reusing the shared STEP-part builder (the same one
// adoption uses, so the two modes cannot drift in body or face naming).
async function ensureStepPart(
  ctx: StepWrite, fileId: string, requestedName: string, fileName: string,
): Promise<StepAssemblyPart> {
  const existing = findStepPart(ctx.tree, fileId, requestedName)
  if (existing !== undefined) {
    return { id: existing, name: ctx.tree.manifest.entries[existing]?.name ?? requestedName, fileId }
  }
  const name = uniqueDocumentName(requestedName, ctx.tree, 'part')
  const id = randomUuid()
  addEntry(ctx.tree, {
    id,
    kind: 'document',
    name,
    docKind: 'part',
    text: buildStepContent(fileId, randomId(18), fileName),
  })
  // The edge is what makes the part reachable from the workspace: the delete
  // guard and the assembly bundle key both read it.
  addReference(ctx.tree, id, fileId)
  return { id, name, fileId }
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

// The stored STEP file entry with these bytes, or undefined. The lookup reads
// the payload-free listing: an opened tree leaves file bytes lazy, so the
// stored content hash is the only way to compare them without loading every
// file. A carrier that does not track hashes (the in-memory conformer) can only
// answer by reading the payload.
async function findStepFile(
  workspace: string,
  bytes: Uint8Array,
  store: WorkspaceStore,
  metas?: readonly EntryMeta[],
): Promise<string | undefined> {
  const contentHash = hashRecord({ kind: 'file', bytes })
  for (const meta of metas ?? await store.listEntries(workspace)) {
    if (meta.kind !== 'file' || meta.fileKind !== STEP_FILE_KIND) continue
    if (meta.contentHash !== undefined) {
      if (meta.contentHash === contentHash) return meta.id
      continue
    }
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

// Display names colliding within one document kind are suffixed like paths are
// (Bracket, Bracket_1), so two parts never read the same in the workspace list.
// A part and the assembly holding it DO share the file's stem: the file names
// both, and each row states its kind ("part" / "assembly"), so suffixing the
// assembly away from the name the user picked the file by would only hide it.
function uniqueDocumentName(base: string, tree: WorkspaceTree, docKind: string): string {
  const taken = new Set(
    Object.values(tree.manifest.entries)
      .filter(row => row.kind === 'document' && row.docKind === docKind)
      .map(row => row.name),
  )
  return uniqueStem(base, candidate => taken.has(candidate))
}
