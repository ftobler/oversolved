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
  idbGetAllFromIndex,
  idbGetFrom,
  idbPutTo,
  idbTransaction,
  idbUpdateFrom,
} from '@/stores/documentStore/idb'
import { suggestedCloneName } from '@/stores/documentStore/cloneName'
import { randomUuid } from '@/utils/randomUuid'
import { entrySizeOf } from '@/utils/entrySize'
import { FORMAT_VERSION, pathFor } from './paths'
import { canonicalizeReferences } from './refs'
import { hashRecord } from './contentHash'

// The workspace row. Structure edits (references, provenance, trash) land here,
// not on the entry rows, which is what keeps a content edit to one record.
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
  // The checkpoint's rev per entry, stamped by checkpoint(). The dirty dot needs
  // id -> rev for every entry, and reading it from the saved records would clone
  // their payloads on every revision bump, so the map rides on the meta row. A
  // meta written before the v7 shape carries none and readers fall back to the
  // saved records until the next checkpoint stamps it.
  savedRevs?: Record<string, number>
  // The checkpoint's copy of the structure the entry rows do not carry. A
  // discard that reset only the rows would put the text of the last save back
  // while leaving references, trash and provenance describing the edits it
  // threw away, so checkpoint() snapshots them here. A row written before this
  // snapshot existed carries none, and discard then leaves the structure alone.
  savedReferences?: ReferenceEdges
  savedTrash?: string[]
  savedProvenance?: ProvenanceRecord[]
  // One-shot content migrations already applied to this workspace, by id. A
  // migration that has to read every payload cannot afford to re-decide that on
  // every open, so it marks itself here and a reopen costs this meta read.
  migrations?: string[]
  // A row written before the storage collapse can still carry `carrier`,
  // `loadedFrom` and `carrierDiverged`. They named a folder or a zip the
  // workspace was supposed to live in, which is not a thing any more; nothing
  // reads them, so they are left inert rather than migrated away.
}

// One working-copy or checkpoint entry. `text` and `bytes` mirror EntryContent:
// a document carries text, a file carries bytes.
//
// `rev` is a change ordinal owned by the working-copy write: IdbCarrier bumps it
// whenever a content-changing write lands, and only then. It feeds the dirty dot
// (working rev against the checkpoint) and `WorkspaceSummary.rev`; it is no
// longer the bundle-cache key, which now follows `contentHash` (A11).
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
  // sha256 of the payload, stamped at every write path. The bundle cache keys
  // on it (folding referenced file hashes in on the main thread), so an undo
  // that restores already-built content lands on the same cached bundle.
  contentHash: string
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
  // The working record's payload hash, so the payload-free listing still feeds
  // the bundle cache's invalidation signal (C5) without a content read.
  contentHash: string
  // R1's derived payload size. Optional because a v5 mirror row written before
  // the size field existed carries none; the v6 upgrade backfills it.
  size?: number
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
    contentHash: record.contentHash,
    size: entrySizeOf(record),
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
  return idbGetAllFromIndex<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, 'by_workspace', workspace)
}

// The payload-free listing read. The U1 grid needs counts, kinds, cover entries
// and revs, none of which require the bytes, so it reads this mirror instead of
// the working copy.
export async function allWorkspaceEntryMetas(): Promise<WorkspaceEntryMetaRecord[]> {
  return idbGetAllFrom<WorkspaceEntryMetaRecord>(STORE_WORKSPACE_ENTRY_META)
}

// One workspace's mirror rows, read through the payload-free store's index.
export async function workspaceEntryMetas(workspace: string): Promise<WorkspaceEntryMetaRecord[]> {
  return idbGetAllFromIndex<WorkspaceEntryMetaRecord>(STORE_WORKSPACE_ENTRY_META, 'by_workspace', workspace)
}

export async function savedEntryRecords(workspace: string): Promise<WorkspaceEntryRecord[]> {
  return idbGetAllFromIndex<WorkspaceEntryRecord>(STORE_WORKSPACE_SAVED, 'by_workspace', workspace)
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

// The mirror row read back as list()'s EntryMeta. The payload fields the mirror
// dropped are exactly the ones EntryMeta never carried, so no fallback read of
// the working copy is needed; `size` falls back only for a pre-v6 row.
function metaToEntryMeta(meta: WorkspaceEntryMetaRecord): EntryMeta {
  const out: EntryMeta = { id: meta.id, path: meta.path, kind: meta.kind, name: meta.name, rev: meta.rev, updatedAt: meta.updatedAt, size: meta.size ?? 0, contentHash: meta.contentHash }
  if (meta.docKind !== undefined) out.docKind = meta.docKind
  if (meta.mime !== undefined) out.mime = meta.mime
  if (meta.fileKind !== undefined) out.fileKind = meta.fileKind
  return out
}

function metaToManifestEntry(meta: WorkspaceEntryMetaRecord): ManifestEntry {
  const row: ManifestEntry = { path: meta.path, kind: meta.kind, name: meta.name }
  if (meta.docKind !== undefined) row.docKind = meta.docKind
  if (meta.mime !== undefined) row.mime = meta.mime
  if (meta.fileKind !== undefined) row.fileKind = meta.fileKind
  return row
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
  const record: WorkspaceEntryRecord = { workspace, id: entry.id, path, kind: entry.kind, name: entry.name, rev, updatedAt, contentHash: '' }
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
  record.contentHash = hashRecord(record)
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
    // The manifest is built from the payload-free mirror; only the document
    // payloads are then read, through the (workspace, kind) index, so a
    // workspace full of large STEP files opens without touching their bytes.
    const metas = await workspaceEntryMetas(this.workspace)
    const manifest: WorkspaceManifest = {
      format: FORMAT_VERSION,
      workspace: this.workspace,
      entries: {},
      references: canonicalizeReferences(meta.references),
      provenance: meta.provenance.map(record => ({ ...record })),
      trash: [...meta.trash].sort(),
    }
    for (const row of metas) manifest.entries[row.id] = metaToManifestEntry(row)
    const contents = new Map<string, EntryContent>()
    const documents = await idbGetAllFromIndex<WorkspaceEntryRecord>(
      STORE_WORKSPACE_ENTRIES,
      'by_workspace_kind',
      IDBKeyRange.only([this.workspace, 'document']),
    )
    for (const record of documents) contents.set(record.id, { text: record.text ?? '' })
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
    // known C2 concurrency limit. The per-record paths do not share it: write()
    // and add() put one row, writeWithReferences() puts a row and its edges in
    // one transaction, and remove()/restore()/addReference()/removeReference()
    // read and rewrite the meta row inside one transaction.
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
    const metas = await workspaceEntryMetas(this.workspace)
    const out: EntryMeta[] = []
    for (const row of metas.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!options.includeTrashed && meta.trash.includes(row.id)) continue
      out.push(metaToEntryMeta(row))
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
    // A byte-identical save is a no-op. `rev` is a change ordinal now, not the
    // bundle-cache key (A11), but churning it on a save that changed nothing
    // would still light the dirty dot against the checkpoint. The live save path
    // is adapter save -> writeEntry -> here, which has no other content guard.
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

  // One working-copy write together with the outgoing edges its text implies.
  // The row and the edge map land in one transaction, so a rejected write never
  // leaves edges describing text that was not stored, and a stored document
  // never disagrees with the edges derived from its own text.
  async writeWithReferences(entry: WorkspaceEntry, targets: string[]): Promise<void> {
    const previous = await this.getRecord(entry.id)
    if (!previous) throw new Error(`Entry not found: ${entry.id}`)
    const merged = mergeContentForWrite(entry, previous)
    // The byte-identical guard of write(): a save that changes no content and
    // moves no edge writes nothing, so it cannot churn the dirty dot.
    const changed = entryChanged(previous, merged)
    await idbUpdateFrom<WorkspaceMetaRecord>(
      [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
      STORE_WORKSPACE_META,
      this.workspace,
      (meta, stores) => {
        if (!meta) throw new Error(`Workspace not found: ${this.workspace}`)
        if (meta.trash.includes(entry.id)) throw new Error(`Entry is trashed: ${entry.id}`)
        if (changed) {
          const record = entryToRecord(this.workspace, merged, previous.path, previous.rev + 1, Date.now())
          stores[STORE_WORKSPACE_ENTRIES].put(record)
          stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
        }
        const references = reconciledReferences(meta.references, entry.id, targets)
        return references === undefined ? undefined : { ...meta, references, updatedAt: Date.now() }
      },
    )
  }

  async add(entry: WorkspaceEntry): Promise<void> {
    const record = await this.newRecord(entry)
    await idbTransaction(
      [STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
      'readwrite',
      stores => {
        stores[STORE_WORKSPACE_ENTRIES].put(record)
        stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
      },
    )
  }

  // add() plus the edges the new entry's text implies, in one transaction: an
  // assembly's part edges must exist the moment its row does, and must not
  // outlive a row that never landed.
  async addWithReferences(entry: WorkspaceEntry, targets: string[]): Promise<void> {
    const record = await this.newRecord(entry)
    await idbUpdateFrom<WorkspaceMetaRecord>(
      [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
      STORE_WORKSPACE_META,
      this.workspace,
      (meta, stores) => {
        if (!meta) throw new Error(`Workspace not found: ${this.workspace}`)
        stores[STORE_WORKSPACE_ENTRIES].put(record)
        stores[STORE_WORKSPACE_ENTRY_META].put(entryMetaOf(record))
        const references = reconciledReferences(meta.references, entry.id, targets)
        return references === undefined ? undefined : { ...meta, references, updatedAt: Date.now() }
      },
    )
  }

  // The working-copy row for a brand-new entry, path uniqueness included. Paths
  // live in the payload-free mirror, so the check never materializes a payload.
  private async newRecord(entry: WorkspaceEntry): Promise<WorkspaceEntryRecord> {
    if (await this.getRecord(entry.id)) throw new Error(`Entry already exists: ${entry.id}`)
    const metas = await workspaceEntryMetas(this.workspace)
    const path = pathFor(entry.kind, entry.name, candidate => metas.some(meta => meta.path === candidate))
    return entryToRecord(this.workspace, entry, path, 1, Date.now())
  }

  async remove(id: string): Promise<void> {
    if (!(await this.getRecord(id))) throw new Error(`Entry not found: ${id}`)
    await this.updateMeta(meta => meta.trash.includes(id)
      ? undefined
      : { ...meta, trash: [...meta.trash, id].sort(), updatedAt: Date.now() })
  }

  async restore(id: string): Promise<void> {
    if (!(await this.getRecord(id))) throw new Error(`Entry not found: ${id}`)
    await this.updateMeta(meta => meta.trash.includes(id)
      ? { ...meta, trash: meta.trash.filter(entry => entry !== id), updatedAt: Date.now() }
      : undefined)
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

  // The whole edge map in one read. Where-used inverts this rather than issuing
  // one metadata read per entry, which is the point of the index.
  async referencesMap(): Promise<ReferenceEdges> {
    const meta = await this.requireMeta()
    return canonicalizeReferences(meta.references)
  }

  async addReference(from: string, to: string): Promise<void> {
    await this.updateMeta(meta => ({
      ...meta,
      references: canonicalizeReferences({ ...meta.references, [from]: [...(meta.references[from] ?? []), to] }),
      updatedAt: Date.now(),
    }))
  }

  async removeReference(from: string, to: string): Promise<void> {
    await this.updateMeta(meta => {
      const targets = (meta.references[from] ?? []).filter(id => id !== to)
      const references = { ...meta.references }
      if (targets.length === 0) delete references[from]
      else references[from] = targets
      return { ...meta, references: canonicalizeReferences(references), updatedAt: Date.now() }
    })
  }

  async maxWorkingRev(): Promise<number> {
    const metas = await workspaceEntryMetas(this.workspace)
    return metas.reduce((max, meta) => Math.max(max, meta.rev), 0)
  }

  async maxSavedRev(): Promise<number> {
    const meta = await readWorkspaceMeta(this.workspace)
    if (meta?.savedRevs) {
      return Object.values(meta.savedRevs).reduce((max, rev) => Math.max(max, rev), 0)
    }
    // A meta written before the map existed still has to answer, so fall back to
    // the checkpoint rows. The next checkpoint stamps the map and stops this.
    const records = await savedEntryRecords(this.workspace)
    return records.reduce((max, record) => Math.max(max, record.rev), 0)
  }

  async lastEditedAt(): Promise<number> {
    const metas = await workspaceEntryMetas(this.workspace)
    return metas.reduce((max, meta) => Math.max(max, meta.updatedAt), 0)
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
    const checkpointRevs = new Map(saved.map(record => [record.id, record.rev]))
    const toPut = working.filter(record => checkpointRevs.get(record.id) !== record.rev)
    const workingIds = new Set(working.map(record => record.id))
    const toDelete = saved.filter(record => !workingIds.has(record.id))
    // The checkpoint adopts the whole working copy, so its rev map is exactly the
    // working revs. Stamping it here is what lets a later read answer the dirty
    // dot without touching the checkpoint payloads. The structure snapshots ride
    // along so discard can put back the references, trash and provenance that
    // belong to the adopted text.
    const nextMeta: WorkspaceMetaRecord = {
      ...meta,
      savedAt: Date.now(),
      // The workspace row's updatedAt is the modified time the library tile
      // shows and sorts on, so the gesture that adopts a save moves it too. The
      // whole-tree save stamped it before; a single-entry save still has to.
      updatedAt: Date.now(),
      savedRevs: Object.fromEntries(working.map(record => [record.id, record.rev])),
      savedReferences: meta.references,
      savedTrash: [...meta.trash],
      savedProvenance: meta.provenance.map(record => ({ ...record })),
    }
    await idbTransaction([STORE_WORKSPACE_SAVED, STORE_WORKSPACE_META], 'readwrite', stores => {
      for (const record of toPut) stores[STORE_WORKSPACE_SAVED].put(record)
      for (const record of toDelete) stores[STORE_WORKSPACE_SAVED].delete([this.workspace, record.id])
      stores[STORE_WORKSPACE_META].put(nextMeta)
    })
  }

  // The recovery prompt's discard: reset the working copy to the checkpoint.
  // Every row and the meta row are grouped in one transaction so the reset
  // cannot be seen half done.
  async discard(): Promise<WorkspaceTree> {
    const meta = await this.requireMeta()
    const working = await workspaceEntryRecords(this.workspace)
    const saved = await savedEntryRecords(this.workspace)
    // The text comes back from the checkpoint rows, and the structure the rows
    // do not carry comes back from the snapshot checkpoint() stamped beside
    // them. A meta written before that snapshot existed has nothing to restore,
    // so its structure is left as it is.
    const nextMeta: WorkspaceMetaRecord | undefined = meta.savedReferences === undefined ? undefined : {
      ...meta,
      references: meta.savedReferences,
      trash: [...(meta.savedTrash ?? [])],
      provenance: (meta.savedProvenance ?? []).map(record => ({ ...record })),
      updatedAt: Date.now(),
    }
    await idbTransaction(
      [STORE_WORKSPACE_META, STORE_WORKSPACE_ENTRIES, STORE_WORKSPACE_ENTRY_META],
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
        if (nextMeta) stores[STORE_WORKSPACE_META].put(nextMeta)
      },
    )
    return this.open()
  }

  private async getRecord(id: string): Promise<WorkspaceEntryRecord | undefined> {
    return idbGetFrom<WorkspaceEntryRecord>(STORE_WORKSPACE_ENTRIES, [this.workspace, id])
  }

  // A structure edit read and written in one transaction. Two editors (a delete
  // and an edge reconcile, say) that each read the row and then wrote it back
  // would lose one update; a read and a write inside one transaction serialize
  // against every other writer of the store. Returning undefined leaves the row
  // untouched.
  private async updateMeta(edit: (meta: WorkspaceMetaRecord) => WorkspaceMetaRecord | undefined): Promise<void> {
    await idbUpdateFrom<WorkspaceMetaRecord>(
      [STORE_WORKSPACE_META],
      STORE_WORKSPACE_META,
      this.workspace,
      meta => {
        if (!meta) throw new Error(`Workspace not found: ${this.workspace}`)
        return edit(meta)
      },
    )
  }

  private async requireMeta(): Promise<WorkspaceMetaRecord> {
    const meta = await readWorkspaceMeta(this.workspace)
    if (!meta) throw new Error(`Workspace not found: ${this.workspace}`)
    return meta
  }
}

// One source's outgoing edge set replaced with what its text implies. Undefined
// when the map already says exactly that, so a write that moves no edge leaves
// the meta row alone.
function reconciledReferences(references: ReferenceEdges, from: string, targets: string[]): ReferenceEdges | undefined {
  const next = [...new Set(targets)].sort()
  const current = references[from] ?? []
  if (current.length === next.length && current.every((id, index) => id === next[index])) return undefined
  const out = { ...references }
  if (next.length === 0) delete out[from]
  else out[from] = next
  return canonicalizeReferences(out)
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
