// The app-facing workspace seam. Workspaces are rows in IndexedDB; each one's
// entries are handled by an IdbCarrier, so this class owns workspace identity
// and the library-level verbs and delegates the entry-level ones. It never
// re-implements tree logic: paths, trash and references go through the carrier,
// which composes C0's tree/manifest code.
//
// IndexedDB is the permanent store and the only one. A folder or a zip is where
// bytes come from (import) or go to (export), never a place a workspace lives,
// so nothing here binds one, fingerprints one or reconciles against one: the
// save writes the working copy and the checkpoint, and that is the whole of it.
//
// In C2 a workspace is degenerate: create mints one workspace and one document
// entry sharing a uuid, so one tile per document and the /documents/:uuid route
// are unchanged.
import { parse as parseYaml } from 'yaml'
import type { EntryMeta, SerializedFile, WorkspaceEntry, WorkspaceTree } from './types'
import {
  IdbCarrier,
  allWorkspaceEntryMetas,
  listWorkspaceMetas,
  purgeWorkspaceRows,
  readWorkspaceMeta,
  replaceWorkspaceRows,
  workspaceEntryMetas,
  writeWorkspaceMeta,
  type WorkspaceEntryMetaRecord,
  type WorkspaceEntryRecord,
  type WorkspaceMetaRecord,
} from './idbCarrier'
import { pathFor } from './paths'
import { serializeTree } from './serializer'
import { remapTree } from './import'
import { EntryReferencedError, type EntryReferrer } from './errors'
import { hashRecord } from './contentHash'
import { randomUuid } from '@/utils/randomUuid'
import { getFileRegistry } from '@/stores/fileRegistry'
import { fileIdsInSpec } from '@/stores/fileRegistry/resolve'
import { getPreviewStore } from '@/stores/previewStore'
import { bumpWorkspaceStoreRevision } from './storeEvents'

export interface WorkspaceSummary {
  workspace: string
  name: string
  docKind?: string  // the sole live document's open kind, for the picker
  entryCount: number
  // R1's derived size: the summed payload bytes of the live entries. Read from
  // the payload-free mirror, so the tile never opens a workspace to report it.
  size: number
  rev?: number  // the working copy's max revision, the tile's change ordinal
  // The entry whose preview stands for the workspace on the U1 tile. First live
  // document, or undefined for an all-file workspace; A9 means the tile shows a
  // placeholder until a save has written a preview for it.
  coverEntry?: string
  createdAt: number
  updatedAt: number
  trashedAt?: string
}

// The library listing options. Deliberately wider than the carrier's ListOptions
// (which only knows about trash), because the grid searches and sorts.
export interface ListOptions {
  search?: string
  sort?: 'name' | 'modified' | 'modified_asc'
  includeTrashed?: boolean
}

export interface OpenWorkspace {
  tree: WorkspaceTree
  workingRev: number  // max entry rev in the working copy
  savedRev: number  // max entry rev at the last explicit save (0 if never)
  ahead: boolean  // workingRev > savedRev, U7's recovery input
  lastEditedAt: number
}

export interface WorkspaceStore {
  list(opts?: ListOptions): Promise<WorkspaceSummary[]>
  create(name: string, opts?: { docKind?: string }): Promise<{ workspace: string }>
  open(workspace: string): Promise<OpenWorkspace>
  close(workspace: string): Promise<void>
  save(workspace: string, tree: WorkspaceTree): Promise<void>
  // One entry's explicit save: write the record, then the whole-tree write and
  // the checkpoint.
  saveEntry(workspace: string, entry: WorkspaceEntry): Promise<void>
  // An adopted bag's landing: the same write as save, named for the gesture
  // that performs it.
  land(workspace: string, tree: WorkspaceTree): Promise<void>
  // Adopt the working copy as the checkpoint (U7's Keep) and reset it to the
  // checkpoint (U7's Discard). Both are the explicit-save bookkeeping in C2.
  checkpoint(workspace: string): Promise<void>
  discard(workspace: string): Promise<void>
  rename(workspace: string, name: string): Promise<void>
  duplicate(workspace: string, name?: string): Promise<{ workspace: string }>
  trash(workspace: string): Promise<void>
  recover(workspace: string): Promise<void>
  purge(workspace: string): Promise<void>
  export(workspace: string): Promise<SerializedFile[]>

  listEntries(workspace: string, opts?: { includeTrashed?: boolean }): Promise<EntryMeta[]>
  readEntry(workspace: string, entry: string): Promise<WorkspaceEntry>
  writeEntry(workspace: string, entry: WorkspaceEntry): Promise<void>
  addEntry(workspace: string, entry: WorkspaceEntry): Promise<string>
  // A soft delete. Refuses (throws EntryReferencedError) when a live entry still
  // references this one, unless `force` is set. `force` is reserved for purge
  // and tests; prune composes the guarded path and surfaces the refusal.
  removeEntry(workspace: string, entry: string, opts?: { force?: boolean }): Promise<void>
  restoreEntry(workspace: string, entry: string): Promise<void>
  // Entry-level rename: a workspace holds many documents now, so the editor's
  // rename gesture names one entry, not the workspace. Path stays manifest-owned
  // (I3); only the display name changes until C4's tree re-parents it.
  renameEntry(workspace: string, entry: string, name: string): Promise<void>
  cloneEntry(workspace: string, entry: string, name?: string): Promise<string>
}

export class IdbWorkspaceStore implements WorkspaceStore {
  private readonly carriers = new Map<string, IdbCarrier>()

  async list(opts: ListOptions = {}): Promise<WorkspaceSummary[]> {
    const metas = await listWorkspaceMetas()
    // The listing reads the payload-free entry mirror, grouped by workspace:
    // counts, cover entries and revs never need a document's text or a file's
    // bytes, so the grid never deserializes a payload just to draw a tile.
    const recordsByWorkspace = new Map<string, WorkspaceEntryMetaRecord[]>()
    for (const record of await allWorkspaceEntryMetas()) {
      const bucket = recordsByWorkspace.get(record.workspace)
      if (bucket) bucket.push(record)
      else recordsByWorkspace.set(record.workspace, [record])
    }
    const summaries: WorkspaceSummary[] = []
    for (const meta of metas) {
      if (!opts.includeTrashed && meta.trashedAt) continue
      const records = recordsByWorkspace.get(meta.workspace) ?? []
      const live = records.filter(record => !meta.trash.includes(record.id))
      const document = live.find(record => record.kind === 'document')
      const summary: WorkspaceSummary = {
        workspace: meta.workspace,
        name: meta.name,
        entryCount: live.length,
        size: live.reduce((sum, record) => sum + (record.size ?? 0), 0),
        rev: live.reduce((max, record) => Math.max(max, record.rev), 0),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      }
      if (document?.docKind !== undefined) summary.docKind = document.docKind
      if (document) summary.coverEntry = document.id
      if (meta.trashedAt !== undefined) summary.trashedAt = meta.trashedAt
      summaries.push(summary)
    }
    let filtered = summaries
    if (opts.search) {
      const needle = opts.search.toLowerCase()
      filtered = filtered.filter(summary => summary.name.toLowerCase().includes(needle))
    }
    filtered.sort((a, b) => {
      if (opts.sort === 'name') return a.name.localeCompare(b.name)
      if (opts.sort === 'modified_asc') return a.updatedAt - b.updatedAt
      return b.updatedAt - a.updatedAt
    })
    return filtered
  }

  // The degenerate workspace: one workspace row and one document entry under the
  // same uuid, so the tile id and the entry id stay the value every existing
  // route already addresses. The caller may supply a docKind; assembly seeding
  // stays the two-step save the documents page already does.
  async create(name: string, opts: { docKind?: string } = {}): Promise<{ workspace: string }> {
    const workspace = randomUuid()
    const now = Date.now()
    const meta: WorkspaceMetaRecord = {
      workspace,
      name,
      createdAt: now,
      updatedAt: now,
      references: {},
      provenance: [],
      trash: [],
    }
    const record: WorkspaceEntryRecord = {
      workspace,
      id: workspace,
      path: pathFor('document', name, () => false),
      kind: 'document',
      name,
      text: '',
      rev: 1,
      contentHash: hashRecord({ kind: 'document', text: '' }),
      updatedAt: now,
    }
    if (opts.docKind !== undefined) record.docKind = opts.docKind
    await replaceWorkspaceRows(workspace, meta, [record])
    // A brand-new workspace is not a recovery: seed the checkpoint with its
    // empty body so `open().ahead` is false until something edits it.
    await this.carrier(workspace).checkpoint()
    bumpWorkspaceStoreRevision()
    return { workspace }
  }

  async open(workspace: string): Promise<OpenWorkspace> {
    const carrier = this.carrier(workspace)
    const tree = await carrier.open()
    const workingRev = await carrier.maxWorkingRev()
    const savedRev = await carrier.maxSavedRev()
    return {
      tree,
      workingRev,
      savedRev,
      ahead: workingRev > savedRev,
      lastEditedAt: await carrier.lastEditedAt(),
    }
  }

  async close(workspace: string): Promise<void> {
    this.carriers.delete(workspace)
  }

  // The explicit save: the working-copy rows, then the checkpoint. There is one
  // boundary at which work can be lost, and this write is where it is crossed.
  async save(workspace: string, tree: WorkspaceTree): Promise<void> {
    const carrier = this.carrier(workspace)
    await carrier.save(tree)
    await carrier.checkpoint()
    bumpWorkspaceStoreRevision()
  }

  async saveEntry(workspace: string, entry: WorkspaceEntry): Promise<void> {
    await this.writeEntry(workspace, entry)
    await this.save(workspace, await this.carrier(workspace).open())
  }

  // Adoption's landing. An import copies bytes in and forgets where they came
  // from, so this is the same write as save: the rows, then the checkpoint.
  async land(workspace: string, tree: WorkspaceTree): Promise<void> {
    await this.save(workspace, tree)
  }

  async checkpoint(workspace: string): Promise<void> {
    await this.carrier(workspace).checkpoint()
    bumpWorkspaceStoreRevision()
  }

  async discard(workspace: string): Promise<void> {
    await this.carrier(workspace).discard()
    bumpWorkspaceStoreRevision()
  }

  async rename(workspace: string, name: string): Promise<void> {
    const meta = await this.requireMeta(workspace)
    const carrier = this.carrier(workspace)
    const metas = await workspaceEntryMetas(workspace)
    // Degenerate case: the sole document shares the workspace's display name, so
    // rename it in step or the editor would keep the old name after open. Only
    // that one record is touched. The old body ran the whole-tree writer, which
    // cloned every entry payload of the workspace to rename one string. The path
    // is left as it is: it is display, and I3 addresses by id, so a rename must
    // not move an entry.
    if (metas.length === 1 && metas[0].kind === 'document') {
      const current = await carrier.read(metas[0].id)
      await carrier.write({ ...current, name })
    }
    await writeWorkspaceMeta({ ...meta, name, updatedAt: Date.now() })
    bumpWorkspaceStoreRevision()
  }

  // A whole-workspace copy under a fresh id. Entry ids are re-minted and the
  // internal reference edges, provenance and trash are remapped through the id
  // map, so a duplicated assembly still resolves its parts. The remap pass is
  // import.ts's, one implementation shared with C6's snapshot-inward copy.
  async duplicate(workspace: string, name?: string): Promise<{ workspace: string }> {
    const meta = await this.requireMeta(workspace)
    const carrier = this.carrier(workspace)
    const tree = await carrier.open()
    await materializeFiles(id => carrier.readPayload(id), tree)
    const nextWorkspace = randomUuid()
    const { tree: copy } = remapTree(tree, {
      workspace: nextWorkspace,
      mintIds: true,
      origin: 'duplicate',
    })
    const now = Date.now()
    const records = treeRecords(nextWorkspace, copy, now)
    const nextMeta: WorkspaceMetaRecord = {
      workspace: nextWorkspace,
      name: name ?? `${meta.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      references: copy.manifest.references,
      provenance: copy.manifest.provenance,
      trash: copy.manifest.trash,
    }
    await replaceWorkspaceRows(nextWorkspace, nextMeta, records)
    await this.carrier(nextWorkspace).checkpoint()
    bumpWorkspaceStoreRevision()
    return { workspace: nextWorkspace }
  }

  // Trashing a workspace is the library-level tombstone documents already use;
  // the rows and previews survive until purge.
  async trash(workspace: string): Promise<void> {
    const meta = await this.requireMeta(workspace)
    await writeWorkspaceMeta({ ...meta, trashedAt: new Date().toISOString(), updatedAt: Date.now() })
    bumpWorkspaceStoreRevision()
  }

  async recover(workspace: string): Promise<void> {
    const meta = await this.requireMeta(workspace)
    const next = { ...meta, updatedAt: Date.now() }
    delete next.trashedAt
    await writeWorkspaceMeta(next)
    bumpWorkspaceStoreRevision()
  }

  async purge(workspace: string): Promise<void> {
    await purgeWorkspaceRows(workspace)
    this.carriers.delete(workspace)
    // Only this app's own rows. A workspace never held a handle to the user's
    // folder or zip, so there is nothing of theirs a purge could reach.
    await getPreviewStore().clearWorkspace(workspace)
    bumpWorkspaceStoreRevision()
  }

  async export(workspace: string): Promise<SerializedFile[]> {
    const carrier = this.carrier(workspace)
    const tree = await carrier.open()
    // The trash travels with the carrier, so materialize through the
    // trash-agnostic read: a trashed file still has to serialize its bytes.
    await materializeFiles(id => carrier.readPayload(id), tree)
    return serializeTree(tree)
  }

  async listEntries(workspace: string, opts: { includeTrashed?: boolean } = {}): Promise<EntryMeta[]> {
    return this.carrier(workspace).list({ includeTrashed: opts.includeTrashed })
  }

  async readEntry(workspace: string, entry: string): Promise<WorkspaceEntry> {
    return this.carrier(workspace).read(entry)
  }

  async writeEntry(workspace: string, entry: WorkspaceEntry): Promise<void> {
    await this.adoptFiles(workspace, entry)
    await this.carrier(workspace).write(entry)
    bumpWorkspaceStoreRevision()
  }

  async addEntry(workspace: string, entry: WorkspaceEntry): Promise<string> {
    await this.adoptFiles(workspace, entry)
    await this.carrier(workspace).add(entry)
    bumpWorkspaceStoreRevision()
    return entry.id
  }

  async removeEntry(workspace: string, entry: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force) {
      const carrier = this.carrier(workspace)
      const references = await carrier.referencesMap()
      // Only live entries block a delete. A referrer already in the trash keeps
      // its edge, but it is not live, so the part can still leave; restoring the
      // referrer later surfaces the missing part as a stale solve (fail loud).
      const liveNames = new Map((await carrier.list()).map(meta => [meta.id, meta.name]))
      const referrers: EntryReferrer[] = []
      for (const [from, targets] of Object.entries(references)) {
        if (!targets.includes(entry)) continue
        const name = liveNames.get(from)
        if (name === undefined) continue
        referrers.push({ id: from, name })
      }
      if (referrers.length > 0) {
        referrers.sort((a, b) => a.name.localeCompare(b.name))
        throw new EntryReferencedError(entry, referrers)
      }
    }
    await this.carrier(workspace).remove(entry)
    bumpWorkspaceStoreRevision()
  }

  async restoreEntry(workspace: string, entry: string): Promise<void> {
    await this.carrier(workspace).restore(entry)
    bumpWorkspaceStoreRevision()
  }

  async renameEntry(workspace: string, entry: string, name: string): Promise<void> {
    const carrier = this.carrier(workspace)
    const current = await carrier.read(entry)
    await carrier.write({ ...current, name })
    bumpWorkspaceStoreRevision()
  }

  // Clone carries the source's outgoing reference edges, which are uuid to uuid
  // and do not need remapping: the cloned part still names the same STEP file.
  async cloneEntry(workspace: string, entry: string, name?: string): Promise<string> {
    const carrier = this.carrier(workspace)
    const references = await carrier.referencesOf(entry)
    const cloneId = await carrier.clone(entry, name)
    for (const to of references) await carrier.addReference(cloneId, to)
    bumpWorkspaceStoreRevision()
    return cloneId
  }

  private carrier(workspace: string): IdbCarrier {
    let carrier = this.carriers.get(workspace)
    if (!carrier) {
      carrier = new IdbCarrier(workspace)
      this.carriers.set(workspace, carrier)
    }
    return carrier
  }

  // Membership write-through and content-driven edge reconciliation. Any file id
  // the document's import_step features name is copied from C1's flat registry
  // into the workspace under the same id; every part_instance.doc_id the document
  // names is an assembly-to-part edge. The document's outgoing edges are then
  // reconciled to exactly that set, so an edit or undo that removes a reference
  // also removes the edge. Deriving the assembly edges from the text rather than
  // recording them at the mutation site is what keeps undo consistent for free.
  private async adoptFiles(workspace: string, entry: WorkspaceEntry): Promise<void> {
    if (entry.kind !== 'document' || entry.text === undefined) return
    let parsed: unknown
    try {
      parsed = parseYaml(entry.text)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const spec = parsed as Record<string, unknown>
    const carrier = this.carrier(workspace)
    const desired = new Set<string>()
    for (const id of fileIdsInSpec(spec)) {
      let present = await carrier.hasEntry(id)
      if (!present) {
        const file = await getFileRegistry().get(id)
        if (!file) continue  // the kernel owns the loud missing-reference error
        await carrier.add({
          id: file.id,
          kind: 'file',
          name: file.name,
          mime: file.mime,
          fileKind: file.kind,
          bytes: new Uint8Array(file.bytes),
        })
        present = true
      }
      if (present) desired.add(id)
    }
    for (const id of partDocIdsInSpec(spec)) desired.add(id)
    const current = await carrier.referencesOf(entry.id)
    for (const to of current) {
      if (!desired.has(to)) await carrier.removeReference(entry.id, to)
    }
    for (const to of desired) {
      if (!current.includes(to)) await carrier.addReference(entry.id, to)
    }
  }

  private async requireMeta(workspace: string): Promise<WorkspaceMetaRecord> {
    const meta = await readWorkspaceMeta(workspace)
    if (!meta) throw new Error(`Workspace not found: ${workspace}`)
    return meta
  }
}

// The working-copy rows a whole tree writes, one per manifest entry. Every
// payload must already be materialized: a document without text or a file
// without bytes is a broken tree, not one to write half of.
function treeRecords(workspace: string, tree: WorkspaceTree, now: number): WorkspaceEntryRecord[] {
  const records: WorkspaceEntryRecord[] = []
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    const content = tree.contents.get(id)
    const record: WorkspaceEntryRecord = {
      workspace,
      id,
      path: row.path,
      kind: row.kind,
      name: row.name,
      rev: 1,
      contentHash: '',
      updatedAt: now,
    }
    if (row.docKind !== undefined) record.docKind = row.docKind
    if (row.mime !== undefined) record.mime = row.mime
    if (row.fileKind !== undefined) record.fileKind = row.fileKind
    if (row.kind === 'document') {
      if (content?.text === undefined) throw new Error(`Document entry ${id} has no text`)
      record.text = content.text
    } else {
      if (content?.bytes === undefined) throw new Error(`File entry ${id} has no bytes`)
      record.bytes = new Uint8Array(content.bytes)
    }
    record.contentHash = hashRecord(record)
    records.push(record)
  }
  return records
}

// Every part_instance.doc_id a parsed document names, deduped. This is the
// assembly-to-part half of the edge set; a part document yields none. A dangling
// id is recorded anyway: an edge is a legal format state (C3's mint branch), and
// the mutation site owns the outward-link refusal.
function partDocIdsInSpec(spec: Record<string, unknown>): string[] {
  const features = spec.features
  if (!Array.isArray(features)) return []
  const ids = new Set<string>()
  for (const f of features) {
    if (!f || typeof f !== 'object') continue
    const feature = f as Record<string, unknown>
    if (feature.kind !== 'part_instance') continue
    const instance = feature.instance
    if (!instance || typeof instance !== 'object') continue
    const id = (instance as Record<string, unknown>).doc_id
    if (typeof id === 'string' && id) ids.add(id)
  }
  return [...ids]
}

// Fill in the file payloads an open tree left unloaded, so serializeTree can
// assert the tree shape and emit real bytes (A5's deferred half). The reader is
// passed in because export must reach trashed file payloads too.
async function materializeFiles(read: (id: string) => Promise<WorkspaceEntry>, tree: WorkspaceTree): Promise<void> {
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'file' || tree.contents.has(id)) continue
    const entry = await read(id)
    const bytes = entry.bytes ?? new Uint8Array(0)
    // A bytes-less file entry would violate assertTree; materializing the
    // missing payload as empty keeps the export shape honest.
    tree.contents.set(id, { bytes: new Uint8Array(bytes) })
  }
}

let instance: WorkspaceStore | null = null

// The lazy singleton, following getFileRegistry, so importing the type from
// this barrel never opens a database connection.
export function getWorkspaceStore(): WorkspaceStore {
  if (!instance) instance = new IdbWorkspaceStore()
  return instance
}
