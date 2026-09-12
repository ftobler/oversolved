// The app-facing workspace seam. Workspaces are rows in IndexedDB; each one's
// entries are handled by an IdbCarrier, so this class owns workspace identity
// and the library-level verbs and delegates the entry-level ones. It never
// re-implements tree logic: paths, trash and references go through the carrier,
// which composes C0's tree/manifest code.
//
// In C2 a workspace is degenerate: create mints one workspace and one document
// entry sharing a uuid, so one tile per document and the /documents/:uuid route
// are unchanged. The explicit save has no external carrier yet, so it writes the
// in-IDB checkpoint (workspace_saved); C3 swaps that for a real carrier write.
import { parse as parseYaml } from 'yaml'
import type { EntryMeta, ReferenceEdges, SerializedFile, WorkspaceEntry, WorkspaceTree } from './types'
import {
  IdbCarrier,
  allWorkspaceEntryRecords,
  listWorkspaceMetas,
  purgeWorkspaceRows,
  readWorkspaceMeta,
  replaceWorkspaceRows,
  workspaceEntryRecords,
  writeWorkspaceMeta,
  type WorkspaceEntryRecord,
  type WorkspaceMetaRecord,
} from './idbCarrier'
import { pathFor } from './paths'
import { serializeTree } from './serializer'
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
  rev?: number  // the working copy's max revision, the bundle cache key
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
  removeEntry(workspace: string, entry: string): Promise<void>
  restoreEntry(workspace: string, entry: string): Promise<void>
  cloneEntry(workspace: string, entry: string, name?: string): Promise<string>
}

export class IdbWorkspaceStore implements WorkspaceStore {
  private readonly carriers = new Map<string, IdbCarrier>()

  async list(opts: ListOptions = {}): Promise<WorkspaceSummary[]> {
    const metas = await listWorkspaceMetas()
    // One full read of the entry store, grouped by workspace. Reading per
    // workspace inside the meta loop made the listing O(workspaces * entries).
    const recordsByWorkspace = new Map<string, WorkspaceEntryRecord[]>()
    for (const record of await allWorkspaceEntryRecords()) {
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
        rev: live.reduce((max, record) => Math.max(max, record.rev), 0),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      }
      if (document?.docKind !== undefined) summary.docKind = document.docKind
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

  // The explicit save. C2 has no external carrier, so it persists the tree into
  // the working copy and then adopts that copy as the checkpoint; C3 replaces
  // the checkpoint write with a real carrier write and keeps the comparison.
  async save(workspace: string, tree: WorkspaceTree): Promise<void> {
    const carrier = this.carrier(workspace)
    await carrier.save(tree)
    await carrier.checkpoint()
    bumpWorkspaceStoreRevision()
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
    const records = await workspaceEntryRecords(workspace)
    const now = Date.now()
    // Degenerate case: the sole document shares the workspace's display name, so
    // rename it in step or the editor would keep the old name after open.
    const renamed = records.map(record => {
      if (records.length !== 1 || record.kind !== 'document') return record
      return {
        ...record,
        name,
        path: pathFor('document', name, () => false),
        rev: record.rev + 1,
        updatedAt: now,
      }
    })
    await replaceWorkspaceRows(workspace, { ...meta, name, updatedAt: now }, renamed)
    bumpWorkspaceStoreRevision()
  }

  // A whole-workspace copy under a fresh id. Entry ids are re-minted and the
  // internal reference edges, provenance and trash are remapped through the
  // id map, so a duplicated assembly still resolves its parts.
  async duplicate(workspace: string, name?: string): Promise<{ workspace: string }> {
    const meta = await this.requireMeta(workspace)
    const records = await workspaceEntryRecords(workspace)
    const nextWorkspace = randomUuid()
    const idMap = new Map(records.map(record => [record.id, randomUuid()]))
    const now = Date.now()
    const copied = records.map(record => {
      const next: WorkspaceEntryRecord = { ...record, workspace: nextWorkspace, id: idMap.get(record.id)! }
      if (record.bytes) next.bytes = new Uint8Array(record.bytes)
      return next
    })
    const references: ReferenceEdges = {}
    for (const [from, targets] of Object.entries(meta.references)) {
      const mappedFrom = idMap.get(from)
      if (!mappedFrom) continue
      const mapped = targets.map(to => idMap.get(to)).filter((to): to is string => to !== undefined)
      if (mapped.length > 0) references[mappedFrom] = mapped
    }
    const provenance = meta.provenance
      .filter(record => idMap.has(record.entry))
      .map(record => ({ ...record, entry: idMap.get(record.entry)! }))
    const trash = meta.trash.map(id => idMap.get(id)).filter((id): id is string => id !== undefined)
    const nextMeta: WorkspaceMetaRecord = {
      workspace: nextWorkspace,
      name: name ?? `${meta.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      references,
      provenance,
      trash,
    }
    await replaceWorkspaceRows(nextWorkspace, nextMeta, copied)
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

  async removeEntry(workspace: string, entry: string): Promise<void> {
    await this.carrier(workspace).remove(entry)
    bumpWorkspaceStoreRevision()
  }

  async restoreEntry(workspace: string, entry: string): Promise<void> {
    await this.carrier(workspace).restore(entry)
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

  // Membership write-through: any file id the document's import_step features
  // name is copied from C1's flat registry into the workspace under the same id,
  // and the document records an edge to it. The registry stays the fallback
  // read until C3 makes the workspace copy the carrier of record.
  private async adoptFiles(workspace: string, entry: WorkspaceEntry): Promise<void> {
    if (entry.kind !== 'document' || entry.text === undefined) return
    let parsed: unknown
    try {
      parsed = parseYaml(entry.text)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const ids = fileIdsInSpec(parsed as Record<string, unknown>)
    if (ids.length === 0) return
    const carrier = this.carrier(workspace)
    const registry = getFileRegistry()
    for (const id of ids) {
      let present = await carrier.hasEntry(id)
      if (!present) {
        const file = await registry.get(id)
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
      if (present) await carrier.addReference(entry.id, id)
    }
  }

  private async requireMeta(workspace: string): Promise<WorkspaceMetaRecord> {
    const meta = await readWorkspaceMeta(workspace)
    if (!meta) throw new Error(`Workspace not found: ${workspace}`)
    return meta
  }
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
