// The IndexedDB conformer of WorkspaceCarrier, and the app's working copy. One
// instance is scoped to one workspace: the workspace row carries the structure
// (references, provenance, trash), and the entry rows carry the payload. The
// explicit-save checkpoint lives beside the working copy in workspace_saved, so
// an edit can be one entry write while keep/discard compare revisions.
//
// Document text is loaded on open because the solve needs it warm (A5); file
// bytes are not, and `read` materializes them on demand. An open tree therefore
// omits file payloads, which assertTree would reject -- a stated seam-internal
// deviation, resolved by materializing before any serialize/export.
import type { ListOptions, WorkspaceCarrier } from './carrier'
import type {
  EntryContent,
  EntryKind,
  EntryMeta,
  ManifestEntry,
  ProvenanceRecord,
  ReferenceEdges,
  WorkspaceEntry,
  WorkspaceManifest,
  WorkspaceTree,
} from './types'
import {
  STORE_WORKSPACE_ENTRIES,
  STORE_WORKSPACE_ENTRY_META,
  STORE_WORKSPACE_META,
  STORE_WORKSPACE_SAVED,
  idbGetAllFrom,
  idbGetFrom,
  idbPutTo,
  idbTransaction,
} from '@/stores/documentStore/idb'
import { suggestedCloneName } from '@/stores/documentStore/cloneName'
import { randomUuid } from '@/utils/randomUuid'
import { FORMAT_VERSION, pathFor } from './paths'
import { canonicalizeReferences } from './refs'

// The workspace row. Structure edits (references, provenance, trash) land here,
// not on the entry rows, which is what keeps a content edit to one record.
export type CarrierKind = 'idb' | 'folder' | 'zip'

// The external save target a workspace names. `carrier` absent means IDB-only,
// which keeps every C2 row valid with no migration. The handle itself is never
// on the row: it lives in the workspace handle registry, and cloning a
// FileSystemHandle into every listing would only be waste.
export interface CarrierBinding {
  kind: CarrierKind
  label?: string
}

// The carrier manifest the working copy was last known to agree with, not the
// working copy's current manifest. P4's carrier-change compare reads it.
export interface LoadedFromRecord {
  carrier: 'folder' | 'zip'
  fingerprint: string
  at: number
}

export interface WorkspaceMetaRecord {
  workspace: string
  name: string
  createdAt: number
  updatedAt: number
  references: ReferenceEdges
  provenance: ProvenanceRecord[]
  trash: string[]
  trashedAt?: string  // library-level tombstone, ISO like documents use today
  savedAt?: number  // epoch ms of the last explicit save
  carrier?: CarrierBinding  // absent == IDB-only
  loadedFrom?: LoadedFromRecord  // the carrier state the working copy agrees with
  // A durable "keep the working copy" after the carrier moved underneath: the
  // next explicit save overwrites, and `open` keeps reporting ahead until then.
  carrierDiverged?: boolean
}

// One working-copy or checkpoint entry. `text` and `bytes` mirror EntryContent:
// a document carries text, a file carries bytes.
export interface WorkspaceEntryRecord {
  workspace: string
  id: string
  path: string
  kind: EntryKind
  name: string
  docKind?: string
  mime?: string
  fileKind?: string
  text?: string
  bytes?: Uint8Array
  rev: number
  updatedAt: number
}

// The payload-free projection of a working-copy record. The grid lists from
// this store so a workspace with hundreds of large files is counted without
// cloning a single payload out of IndexedDB.
export interface WorkspaceEntryMetaRecord {
  workspace: string
  id: string
  path: string
  kind: EntryKind
  name: string
  docKind?: string
  mime?: string
  fileKind?: string
  rev: number
  updatedAt: number
}

function entryMetaOf(record: WorkspaceEntryRecord): WorkspaceEntryMetaRecord {
  const meta: WorkspaceEntryMetaRecord = {
    workspace: record.workspace,
    id: record.id,
    path: record.path,
    kind: record.kind,
    name: record.name,
    rev: record.rev,
    updatedAt: record.updatedAt,
  }
  if (record.docKind !== undefined) meta.docKind = record.docKind
  if (record.mime !== undefined) meta.mime = record.mime
  if (record.fileKind !== undefined) meta.fileKind = record.fileKind
  return meta
}

export async function readWorkspaceMeta(workspace: string): Promise<WorkspaceMetaRecord | undefined> {
  return idbGetFrom<WorkspaceMetaRecord>(STORE_WORKSPACE_META, workspace)
}

export async function listWorkspaceMetas(): Promise<WorkspaceMetaRecord[]> {
  return idbGetAllFrom<WorkspaceMetaRecord>(STORE_WORKSPACE_META)
}

export async function writeWorkspaceMeta(meta: WorkspaceMetaRecord): Promise<void> {
  await idbPutTo(STORE_WORKSPACE_META, meta)
}

export async function workspaceEntryRecords(workspace: string): Promise<WorkspaceEntryRecord[]> {
  const all = await idbGetAllFrom<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES)
  return all.filter(record => record.workspace === workspace)
}

// Every working-copy record in one read. The library listing groups these by
// workspace so it does one full-store read instead of one per workspace.
export async function allWorkspaceEntryRecords(): Promise<WorkspaceEntryRecord[]> {
  return idbGetAllFrom<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES)
}

// The payload-free listing read. The U1 grid needs counts, kinds, cover entries
// and revs, none of which require the bytes, so it reads this mirror instead of
// `allWorkspaceEntryRecords`.
export async function allWorkspaceEntryMetas(): Promise<WorkspaceEntryMetaRecord[]> {
  return idbGetAllFrom<WorkspaceEntryMetaRecord>(STORE_WORKSPACE_ENTRY_META)
}

export async function savedEntryRecords(workspace: string): Promise<WorkspaceEntryRecord[]> {
  const all = await idbGetAllFrom<WorkspaceEntryRecord>(STORE_WORKSPACE_SAVED)
  return all.filter(record => record.workspace === workspace)
}

// Atomically replace one workspace's working copy and its meta row, used by
// create and by duplicate's whole-workspace copy. Orphaned rows are dropped so
// the replacement is exact rather than a merge.
export async function replaceWorkspaceRows(
  workspace: string,
  meta: WorkspaceMetaRecord,
  records: WorkspaceEntryRecord[],
): Promise<void> {
  const previous = await workspaceEntryRecords(workspace)
  await idbTransaction(
    [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
    'readwrite',
    stores => {
      for (const record of previous) {
        stores[STORE_WORKSPACE_ENTRIES].delete([workspace, record.id])
        stores[STORE_WORKSPACE_ENTRY_META].delete([workspace, record.id])
      }
      for (const record of records) {
        stores[STORE_WORKSPACE_ENTRIES].put(record)
        stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
      }
      stores[STORE_WORKSPACE_META].put(meta)
    },
  )
}

// Hard-delete every row a workspace owns: the tombstone's purge end. The meta,
// working copy and checkpoint go in one transaction so none is left behind.
export async function purgeWorkspaceRows(workspace: string): Promise<void> {
  const entries = await workspaceEntryRecords(workspace)
  const saved = await savedEntryRecords(workspace)
  await idbTransaction(
    [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META, STORE_WORKSPACE_SAVED],
    'readwrite',
    stores => {
      stores[STORE_WORKSPACE_META].delete(workspace)
      for (const record of entries) {
        stores[STORE_WORKSPACE_ENTRIES].delete([workspace, record.id])
        stores[STORE_WORKSPACE_ENTRY_META].delete([workspace, record.id])
      }
      for (const record of saved) stores[STORE_WORKSPACE_SAVED].delete([workspace, record.id])
    },
  )
}

function recordToManifestEntry(record: WorkspaceEntryRecord): ManifestEntry {
  const row: ManifestEntry = { path: record.path, kind: record.kind, name: record.name }
  if (record.docKind !== undefined) row.docKind = record.docKind
  if (record.mime !== undefined) row.mime = record.mime
  if (record.fileKind !== undefined) row.fileKind = record.fileKind
  return row
}

function recordToMeta(record: WorkspaceEntryRecord): EntryMeta {
  const meta: EntryMeta = { id: record.id, path: record.path, kind: record.kind, name: record.name, rev: record.rev, updatedAt: record.updatedAt }
  if (record.docKind !== undefined) meta.docKind = record.docKind
  if (record.mime !== undefined) meta.mime = record.mime
  if (record.fileKind !== undefined) meta.fileKind = record.fileKind
  return meta
}

function recordToEntry(record: WorkspaceEntryRecord): WorkspaceEntry {
  const entry: WorkspaceEntry = { id: record.id, kind: record.kind, name: record.name }
  if (record.docKind !== undefined) entry.docKind = record.docKind
  if (record.mime !== undefined) entry.mime = record.mime
  if (record.fileKind !== undefined) entry.fileKind = record.fileKind
  if (record.text !== undefined) entry.text = record.text
  if (record.bytes !== undefined) entry.bytes = new Uint8Array(record.bytes)
  return entry
}

function entryToRecord(
  workspace: string,
  entry: WorkspaceEntry,
  path: string,
  rev: number,
  updatedAt: number,
): WorkspaceEntryRecord {
  const record: WorkspaceEntryRecord = { workspace, id: entry.id, path, kind: entry.kind, name: entry.name, rev, updatedAt }
  if (entry.docKind !== undefined) record.docKind = entry.docKind
  if (entry.mime !== undefined) record.mime = entry.mime
  if (entry.fileKind !== undefined) record.fileKind = entry.fileKind
  if (entry.kind === 'document') {
    if (entry.text === undefined) throw new Error(`Document entry ${entry.id} has no text`)
    record.text = entry.text
  } else {
    if (entry.bytes === undefined) throw new Error(`File entry ${entry.id} has no bytes`)
    record.bytes = new Uint8Array(entry.bytes)
  }
  return record
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

// Whether a tree row differs from the stored one. A missing content slot means
// the payload was not loaded (a file's lazy bytes), which is not a change.
function rowChanged(
  previous: WorkspaceEntryRecord | undefined,
  row: ManifestEntry,
  content: EntryContent | undefined,
): boolean {
  if (!previous) return true
  // Path is part of the row identity's display: a move (C4) changes it without
  // touching the payload, so a path-only change must register as a change.
  if (
    previous.name !== row.name || previous.path !== row.path ||
    previous.docKind !== row.docKind ||
    previous.mime !== row.mime || previous.fileKind !== row.fileKind
  ) return true
  if (previous.kind === 'document') {
    return content?.text !== undefined && previous.text !== content.text
  }
  return content?.bytes !== undefined && !sameBytes(previous.bytes, content.bytes)
}

// Whether a write() would change the stored record. `write` takes a
// WorkspaceEntry rather than a manifest row plus content, so this compares the
// aggregate directly. A file whose bytes were not loaded stays a no-op.
function entryChanged(previous: WorkspaceEntryRecord, entry: WorkspaceEntry): boolean {
  if (
    previous.kind !== entry.kind || previous.name !== entry.name ||
    previous.docKind !== entry.docKind || previous.mime !== entry.mime ||
    previous.fileKind !== entry.fileKind
  ) return true
  if (previous.kind === 'document') return previous.text !== entry.text
  return entry.bytes !== undefined && !sameBytes(previous.bytes, entry.bytes)
}

export class IdbCarrier implements WorkspaceCarrier {
  readonly workspace: string

  constructor(workspace: string) {
    this.workspace = workspace
  }

  async open(): Promise<WorkspaceTree> {
    const meta = await this.requireMeta()
    const records = await workspaceEntryRecords(this.workspace)
    const manifest: WorkspaceManifest = {
      format: FORMAT_VERSION,
      workspace: this.workspace,
      entries: {},
      references: canonicalizeReferences(meta.references),
      provenance: meta.provenance.map(record => ({ ...record })),
      trash: [...meta.trash].sort(),
    }
    const contents = new Map<string, EntryContent>()
    for (const record of records) {
      manifest.entries[record.id] = recordToManifestEntry(record)
      // Documents are loaded eagerly; file payloads are left out until read.
      if (record.kind === 'document') contents.set(record.id, { text: record.text ?? '' })
    }
    return { manifest, contents }
  }

  // Persist a whole tree as the working copy. Structure comes from the
  // manifest, payloads from contents; a file whose bytes were not loaded keeps
  // the stored payload, so saving an opened tree never zeroes a lazy file.
  async save(tree: WorkspaceTree): Promise<void> {
    // The reads below happen before the write transaction opens, so a second
    // tab can land an edit in the window between this tab's read and its write
    // and this whole-tree write would clobber it. Taking the reads inside one
    // transaction is not a drop-in change: the getAll -> compute -> put chain
    // must stay in a single transaction task, and idbTransaction runs `build`
    // synchronously while its result is needed to decide the writes. Left as a
    // known C2 concurrency limit; write()/remove()/restore() each do one
    // record and are not exposed to it.
    const meta = await this.requireMeta()
    const existing = new Map((await workspaceEntryRecords(this.workspace)).map(record => [record.id, record]))
    const now = Date.now()
    const writes: WorkspaceEntryRecord[] = []
    const seen = new Set<string>()
    for (const [id, row] of Object.entries(tree.manifest.entries)) {
      const previous = existing.get(id)
      const content = tree.contents.get(id)
      if (!previous || rowChanged(previous, row, content)) {
        const merged = mergeContent(id, row, content, previous)
        const rev = (previous?.rev ?? 0) + 1
        // The manifest row owns the path: a move persists through save, and a
        // rename-only write() below is the one path-stable exception.
        writes.push(entryToRecord(this.workspace, merged, row.path, rev, now))
      }
      seen.add(id)
    }
    const deletes = [...existing.keys()].filter(id => !seen.has(id))
    const nextMeta: WorkspaceMetaRecord = {
      ...meta,
      references: canonicalizeReferences(tree.manifest.references),
      provenance: tree.manifest.provenance.map(record => ({ ...record })),
      trash: [...tree.manifest.trash].sort(),
      updatedAt: now,
    }
    await idbTransaction(
      [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
      'readwrite',
      stores => {
        for (const record of writes) {
          stores[STORE_WORKSPACE_ENTRIES].put(record)
          stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
        }
        for (const id of deletes) {
          stores[STORE_WORKSPACE_ENTRIES].delete([this.workspace, id])
          stores[STORE_WORKSPACE_ENTRY_META].delete([this.workspace, id])
        }
        stores[STORE_WORKSPACE_META].put(nextMeta)
      },
    )
  }

  async list(options: ListOptions = {}): Promise<EntryMeta[]> {
    const meta = await this.requireMeta()
    const records = await workspaceEntryRecords(this.workspace)
    const out: EntryMeta[] = []
    for (const record of records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!options.includeTrashed && meta.trash.includes(record.id)) continue
      out.push(recordToMeta(record))
    }
    return out
  }

  async read(id: string): Promise<WorkspaceEntry> {
    const meta = await this.requireMeta()
    if (meta.trash.includes(id)) throw new Error(`Entry is trashed: ${id}`)
    return this.readPayload(id)
  }

  // A payload read that ignores the trash. The trash travels with the carrier
  // and is excluded from list and solve only, never from serialization, so
  // export must be able to materialize a trashed file's bytes. `read` keeps the
  // live-only check for the carrier contract.
  async readPayload(id: string): Promise<WorkspaceEntry> {
    const record = await this.getRecord(id)
    if (!record) throw new Error(`Entry not found: ${id}`)
    return recordToEntry(record)
  }

  async write(entry: WorkspaceEntry): Promise<void> {
    const meta = await this.requireMeta()
    if (meta.trash.includes(entry.id)) throw new Error(`Entry is trashed: ${entry.id}`)
    const previous = await this.getRecord(entry.id)
    if (!previous) throw new Error(`Entry not found: ${entry.id}`)
    const merged = mergeContentForWrite(entry, previous)
    // A byte-identical save is a no-op. `rev` is the assembly bundle-cache key
    // (A11), so churning it on a save that changed nothing needlessly evicts a
    // cache entry that is still correct. The live save path is adapter save ->
    // writeEntry -> here, which has no other content guard.
    if (!entryChanged(previous, merged)) return
    const record = entryToRecord(this.workspace, merged, previous.path, previous.rev + 1, Date.now())
    await idbTransaction(
      [STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
      'readwrite',
      stores => {
        stores[STORE_WORKSPACE_ENTRIES].put(record)
        stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
      },
    )
  }

  async add(entry: WorkspaceEntry): Promise<void> {
    if (await this.getRecord(entry.id)) throw new Error(`Entry already exists: ${entry.id}`)
    const records = await workspaceEntryRecords(this.workspace)
    const path = pathFor(entry.kind, entry.name, candidate => records.some(record => record.path === candidate))
    const record = entryToRecord(this.workspace, entry, path, 1, Date.now())
    await idbTransaction(
      [STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
      'readwrite',
      stores => {
        stores[STORE_WORKSPACE_ENTRIES].put(record)
        stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
      },
    )
  }

  async remove(id: string): Promise<void> {
    const meta = await this.requireMeta()
    if (!(await this.getRecord(id))) throw new Error(`Entry not found: ${id}`)
    if (meta.trash.includes(id)) return
    await this.putMeta({ ...meta, trash: [...meta.trash, id].sort(), updatedAt: Date.now() })
  }

  async restore(id: string): Promise<void> {
    const meta = await this.requireMeta()
    if (!(await this.getRecord(id))) throw new Error(`Entry not found: ${id}`)
    if (!meta.trash.includes(id)) return
    await this.putMeta({ ...meta, trash: meta.trash.filter(entry => entry !== id), updatedAt: Date.now() })
  }

  async clone(id: string, name?: string): Promise<string> {
    const source = await this.read(id)
    const clone: WorkspaceEntry = { id: randomUuid(), kind: source.kind, name: name ?? suggestedCloneName(source.name) }
    if (source.docKind !== undefined) clone.docKind = source.docKind
    if (source.mime !== undefined) clone.mime = source.mime
    if (source.fileKind !== undefined) clone.fileKind = source.fileKind
    if (source.text !== undefined) clone.text = source.text
    if (source.bytes !== undefined) clone.bytes = new Uint8Array(source.bytes)
    await this.add(clone)
    return clone.id
  }

  async hasEntry(id: string): Promise<boolean> {
    return (await this.getRecord(id)) !== undefined
  }

  async referencesOf(id: string): Promise<string[]> {
    const meta = await this.requireMeta()
    return [...(meta.references[id] ?? [])]
  }

  async addReference(from: string, to: string): Promise<void> {
    const meta = await this.requireMeta()
    const targets = [...(meta.references[from] ?? []), to]
    await this.putMeta({ ...meta, references: canonicalizeReferences({ ...meta.references, [from]: targets }), updatedAt: Date.now() })
  }

  async maxWorkingRev(): Promise<number> {
    const records = await workspaceEntryRecords(this.workspace)
    return records.reduce((max, record) => Math.max(max, record.rev), 0)
  }

  async maxSavedRev(): Promise<number> {
    const records = await savedEntryRecords(this.workspace)
    return records.reduce((max, record) => Math.max(max, record.rev), 0)
  }

  async lastEditedAt(): Promise<number> {
    const records = await workspaceEntryRecords(this.workspace)
    return records.reduce((max, record) => Math.max(max, record.updatedAt), 0)
  }

  // Adopt the working copy as the checkpoint: copy every entry whose rev moved,
  // drop checkpoint rows whose working entry is gone, and stamp savedAt. One
  // transaction, so a crash leaves either the old checkpoint or the new one.
  async checkpoint(): Promise<void> {
    // Same pre-transaction read window as save(): a concurrent tab's write can
    // land between these reads and the checkpoint transaction, so this
    // checkpoint adopts a slightly stale working copy. The next explicit save
    // re-adopts, so the cost is a missed rev, not lost content.
    const meta = await this.requireMeta()
    const working = await workspaceEntryRecords(this.workspace)
    const saved = await savedEntryRecords(this.workspace)
    const savedRevs = new Map(saved.map(record => [record.id, record.rev]))
    const toPut = working.filter(record => savedRevs.get(record.id) !== record.rev)
    const workingIds = new Set(working.map(record => record.id))
    const toDelete = saved.filter(record => !workingIds.has(record.id))
    const nextMeta: WorkspaceMetaRecord = { ...meta, savedAt: Date.now() }
    await idbTransaction([STORE_WORKSPACE_SAVED, STORE_WORKSPACE_META], 'readwrite', stores => {
      for (const record of toPut) stores[STORE_WORKSPACE_SAVED].put(record)
      for (const record of toDelete) stores[STORE_WORKSPACE_SAVED].delete([this.workspace, record.id])
      stores[STORE_WORKSPACE_META].put(nextMeta)
    })
  }

  // The recovery prompt's discard: reset the working copy to the checkpoint.
  // Every row is grouped in one transaction so the reset cannot be seen half done.
  async discard(): Promise<WorkspaceTree> {
    const working = await workspaceEntryRecords(this.workspace)
    const saved = await savedEntryRecords(this.workspace)
    await idbTransaction(
      [STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
      'readwrite',
      stores => {
        for (const record of working) {
          stores[STORE_WORKSPACE_ENTRIES].delete([this.workspace, record.id])
          stores[STORE_WORKSPACE_ENTRY_META].delete([this.workspace, record.id])
        }
        for (const record of saved) {
          stores[STORE_WORKSPACE_ENTRIES].put(record)
          stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
        }
      },
    )
    return this.open()
  }

  private async getRecord(id: string): Promise<WorkspaceEntryRecord | undefined> {
    return idbGetFrom<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [this.workspace, id])
  }

  private async putMeta(meta: WorkspaceMetaRecord): Promise<void> {
    await idbTransaction([STORE_WORKSPACE_META], 'readwrite', stores => {
      stores[STORE_WORKSPACE_META].put(meta)
    })
  }

  private async requireMeta(): Promise<WorkspaceMetaRecord> {
    const meta = await readWorkspaceMeta(this.workspace)
    if (!meta) throw new Error(`Workspace not found: ${this.workspace}`)
    return meta
  }
}

// A tree row plus its content, with a lazy file payload filled back in from the
// stored record when the caller never loaded it.
function mergeContent(
  id: string,
  row: ManifestEntry,
  content: EntryContent | undefined,
  previous: WorkspaceEntryRecord | undefined,
): WorkspaceEntry {
  const entry: WorkspaceEntry = { id, kind: row.kind, name: row.name }
  if (row.docKind !== undefined) entry.docKind = row.docKind
  if (row.mime !== undefined) entry.mime = row.mime
  if (row.fileKind !== undefined) entry.fileKind = row.fileKind
  if (row.kind === 'document') {
    if (content?.text === undefined) throw new Error(`Document entry ${row.name} has no text`)
    entry.text = content.text
  } else {
    const bytes = content?.bytes ?? previous?.bytes
    if (bytes === undefined) throw new Error(`File entry ${row.name} has no bytes`)
    entry.bytes = new Uint8Array(bytes)
  }
  return entry
}

// write() needs the same lazy fill for a file the caller read only as metadata.
function mergeContentForWrite(entry: WorkspaceEntry, previous: WorkspaceEntryRecord): WorkspaceEntry {
  if (entry.kind === 'file' && entry.bytes === undefined) {
    if (previous.bytes === undefined) throw new Error(`File entry ${entry.id} has no bytes`)
    return { ...entry, bytes: new Uint8Array(previous.bytes) }
  }
  return entry
}
