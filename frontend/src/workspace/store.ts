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
import type { EntryMeta, SerializedFile, WorkspaceEntry, WorkspaceTree } from './types'
import {
  IdbCarrier,
  allWorkspaceEntryMetas,
  listWorkspaceMetas,
  purgeWorkspaceRows,
  readWorkspaceMeta,
  replaceWorkspaceRows,
  workspaceEntryRecords,
  writeWorkspaceMeta,
  type CarrierBinding,
  type WorkspaceEntryMetaRecord,
  type WorkspaceEntryRecord,
  type WorkspaceMetaRecord,
} from './idbCarrier'
import { pathFor } from './paths'
import { serializeTree } from './serializer'
import { remapTree } from './import'
import { folderTarget, resolveCarrierTarget, zipTarget, type CarrierTarget } from './carrierTarget'
import type { ReconcileReport } from './directoryCarrier'
import {
  forgetWorkspaceHandle,
  forgetWorkspaceZipHandle,
  rememberWorkspaceHandle,
  rememberWorkspaceZipHandle,
} from './workspaceHandleRegistry'
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
  rev?: number  // the working copy's max revision, the bundle cache key
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
  ahead: boolean  // workingRev > savedRev or carrierDiverged, U7's recovery input
  lastEditedAt: number
  // P4's carrier-change evidence. `externalChanged` means the carrier manifest
  // no longer matches the fingerprint the working copy agreed with; `reconcile`
  // is the folder's presence/absence report from the same check.
  externalChanged?: boolean
  carrierUnavailable?: boolean
  carrierKind?: 'folder' | 'zip'
  carrierLabel?: string
  reconcile?: ReconcileReport
}

// What the carrier-change check found, shared by open and the focus/reopen
// re-check. `none` is an IDB-only workspace: one working copy, no external file.
export type CarrierCheckStatus = 'none' | 'clean' | 'changed' | 'unavailable'
export interface CarrierCheck {
  status: CarrierCheckStatus
  carrier?: 'folder' | 'zip'
  label?: string
  reconcile?: ReconcileReport
}

// U1's binding for "open this folder/zip as the workspace's save target". The
// handle is remembered in the workspace handle registry; IDB stays the working
// copy and the first explicit save writes the carrier.
export interface CarrierTargetBinding {
  kind: 'folder' | 'zip'
  label?: string
  handle: FileSystemDirectoryHandle | FileSystemFileHandle
}

export interface WorkspaceStore {
  list(opts?: ListOptions): Promise<WorkspaceSummary[]>
  create(name: string, opts?: { docKind?: string; target?: CarrierTargetBinding }): Promise<{ workspace: string }>
  open(workspace: string): Promise<OpenWorkspace>
  close(workspace: string): Promise<void>
  save(workspace: string, tree: WorkspaceTree): Promise<void>
  // One entry's explicit save: write the record, then the whole-tree carrier
  // write and checkpoint. The editor save routes through here so a carrier
  // stays in step with the working copy.
  saveEntry(workspace: string, entry: WorkspaceEntry): Promise<void>
  // Working-copy-only landing for an adopted bag: write the rows and checkpoint
  // without touching the bound carrier. Opening a folder of 200 files must not
  // rewrite 200 files; the next explicit save normalizes the layout.
  land(workspace: string, tree: WorkspaceTree): Promise<void>
  // Bind a folder or zip as this workspace's external save target. The carrier
  // is not written; the first explicit save is.
  attachCarrier(workspace: string, binding: CarrierTargetBinding): Promise<void>
  // Re-run the carrier-change compare for the open workspace (the Reopen click,
  // and later the focus listener). A no-op for an IDB-only workspace.
  checkCarrier(workspace: string): Promise<CarrierCheck>
  // P4's three explicit resolutions of a carrier change. Reload replaces the
  // working copy from the carrier and checkpoints; Keep marks the divergence
  // durable so the next save overwrites; Save over writes the carrier from the
  // working copy. Each records the carrier's fingerprint in loadedFrom, which
  // stops the change prompt.
  reloadFromCarrier(workspace: string): Promise<void>
  keepWorkingCopy(workspace: string): Promise<void>
  saveOverCarrier(workspace: string): Promise<void>
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
  // Entry-level rename: a workspace holds many documents now, so the editor's
  // rename gesture names one entry, not the workspace. Path stays manifest-owned
  // (I3); only the display name changes until C4's tree re-parents it.
  renameEntry(workspace: string, entry: string, name: string): Promise<void>
  cloneEntry(workspace: string, entry: string, name?: string): Promise<string>
}

export class IdbWorkspaceStore implements WorkspaceStore {
  private readonly carriers = new Map<string, IdbCarrier>()
  // The resolved external targets, beside the carriers map and dropped with it
  // in close. Caching them keeps one save from re-running the permission probe
  // and, for a zip, re-reading the whole archive on every entry save.
  private readonly targets = new Map<string, CarrierTarget>()

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
  async create(name: string, opts: { docKind?: string; target?: CarrierTargetBinding } = {}): Promise<{ workspace: string }> {
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
    if (opts.target) meta.carrier = bindingOf(opts.target)
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
    if (opts.target) await this.bindTarget(workspace, opts.target)
    // A brand-new workspace is not a recovery: seed the checkpoint with its
    // empty body so `open().ahead` is false until something edits it.
    await this.carrier(workspace).checkpoint()
    bumpWorkspaceStoreRevision()
    return { workspace }
  }

  async open(workspace: string): Promise<OpenWorkspace> {
    const carrier = this.carrier(workspace)
    const tree = await carrier.open()
    const meta = await this.requireMeta(workspace)
    // Open only needs the change verdict; the folder reconcile scan is deferred
    // to the explicit check (Reopen, and P4's focus path) so a dirty-refresh
    // open does not walk the whole folder on every keystroke.
    const check = await this.carrierCheck(workspace, false)
    const workingRev = await carrier.maxWorkingRev()
    const savedRev = await carrier.maxSavedRev()
    const opened: OpenWorkspace = {
      tree,
      workingRev,
      savedRev,
      // A durable Keep (carrierDiverged) keeps the workspace ahead across a
      // reload, so the next explicit save still overwrites the stale carrier.
      ahead: workingRev > savedRev || meta.carrierDiverged === true,
      lastEditedAt: await carrier.lastEditedAt(),
    }
    if (check.status !== 'none') {
      opened.externalChanged = check.status === 'changed'
      opened.carrierUnavailable = check.status === 'unavailable'
      if (check.carrier !== undefined) opened.carrierKind = check.carrier
    }
    if (check.label !== undefined) opened.carrierLabel = check.label
    if (check.reconcile !== undefined) opened.reconcile = check.reconcile
    return opened
  }

  async close(workspace: string): Promise<void> {
    this.carriers.delete(workspace)
    this.targets.delete(workspace)
  }

  // The explicit save: the working copy first, so a carrier failure never loses
  // the in-app edit, then the external target, then the checkpoint and the
  // fingerprint the carrier now agrees with. An IDB-only workspace skips the
  // target and behaves exactly as C2.
  async save(workspace: string, tree: WorkspaceTree): Promise<void> {
    const carrier = this.carrier(workspace)
    await carrier.save(tree)
    const meta = await this.requireMeta(workspace)
    if (isExternal(meta)) {
      const target = await this.target(workspace, meta, false)
      if (!target) {
        // Never silently fall back to IDB-only, and never checkpoint: without
        // the carrier write the save did not happen, so the workspace stays
        // ahead (dirty) and the named failure reaches the caller.
        bumpWorkspaceStoreRevision()
        throw new Error(`Workspace carrier is unavailable: ${workspace}`)
      }
      // An opened working copy leaves file bytes lazy; the carrier needs real
      // bytes, so materialize through the trash-agnostic reader before writing.
      await materializeFiles(id => carrier.readPayload(id), tree)
      await target.save(tree)
      await this.recordLoadedFrom(workspace, target)
    }
    await carrier.checkpoint()
    bumpWorkspaceStoreRevision()
  }

  async saveEntry(workspace: string, entry: WorkspaceEntry): Promise<void> {
    await this.writeEntry(workspace, entry)
    await this.save(workspace, await this.carrier(workspace).open())
  }

  // Adoption's landing: the working copy only, then the checkpoint. The bound
  // target is left untouched so opening a folder does not rewrite it; the
  // fingerprint is seeded from whatever manifest it already holds.
  async land(workspace: string, tree: WorkspaceTree): Promise<void> {
    const carrier = this.carrier(workspace)
    await carrier.save(tree)
    await this.seedLoadedFrom(workspace)
    await carrier.checkpoint()
    bumpWorkspaceStoreRevision()
  }

  async attachCarrier(workspace: string, binding: CarrierTargetBinding): Promise<void> {
    const meta = await this.requireMeta(workspace)
    const target = await this.bindTarget(workspace, binding)
    const next: WorkspaceMetaRecord = { ...meta, carrier: bindingOf(binding), carrierDiverged: false }
    const fingerprint = await target.readManifestFingerprint()
    if (fingerprint !== null) next.loadedFrom = { carrier: target.kind, fingerprint, at: Date.now() }
    else delete next.loadedFrom
    await writeWorkspaceMeta(next)
    bumpWorkspaceStoreRevision()
  }

  async checkCarrier(workspace: string): Promise<CarrierCheck> {
    return this.carrierCheck(workspace, true)
  }

  // Resolution 1: the carrier wins. Its tree replaces the working copy, the
  // checkpoint adopts it, and loadedFrom records the carrier hash so the prompt
  // stops. Previews keyed (workspace, entry) survive because entry ids are
  // manifest-owned and stable, so this replaces rows, never identity.
  async reloadFromCarrier(workspace: string): Promise<void> {
    const meta = await this.requireMeta(workspace)
    if (!isExternal(meta)) return
    const target = await this.target(workspace, meta, true)
    if (!target) throw new Error(`Workspace carrier is unavailable: ${workspace}`)
    const tree = await target.openTree()
    // An opened tree leaves file bytes lazy; reload must copy the carrier's
    // bytes, not the working copy's, so read each one back before replacing rows.
    await materializeFiles(id => target.readPayload(id), tree)
    const now = Date.now()
    const nextMeta: WorkspaceMetaRecord = {
      ...meta,
      references: tree.manifest.references,
      provenance: tree.manifest.provenance.map(record => ({ ...record })),
      trash: [...tree.manifest.trash].sort(),
      updatedAt: now,
    }
    await replaceWorkspaceRows(workspace, nextMeta, treeRecords(workspace, tree, now))
    await this.carrier(workspace).checkpoint()
    await this.recordLoadedFrom(workspace, target)
    bumpWorkspaceStoreRevision()
  }

  // Resolution 2: the working copy wins for now. loadedFrom moves to the
  // carrier's current hash so the prompt stops, and carrierDiverged keeps the
  // workspace ahead (and dirty) across a reload, so the next explicit save still
  // overwrites the stale carrier. The carrier itself is not touched.
  async keepWorkingCopy(workspace: string): Promise<void> {
    const meta = await this.requireMeta(workspace)
    if (!isExternal(meta)) return
    const target = await this.target(workspace, meta, false)
    if (!target) throw new Error(`Workspace carrier is unavailable: ${workspace}`)
    const next: WorkspaceMetaRecord = { ...meta, carrierDiverged: true }
    const fingerprint = await target.readManifestFingerprint()
    if (fingerprint !== null) next.loadedFrom = { carrier: target.kind, fingerprint, at: Date.now() }
    else delete next.loadedFrom
    await writeWorkspaceMeta(next)
    bumpWorkspaceStoreRevision()
  }

  // Resolution 3: the working copy wins outright. Materialize its lazy file
  // bytes so the carrier write is complete, then the one explicit save writes
  // the carrier, checkpoints and clears carrierDiverged through loadedFrom.
  async saveOverCarrier(workspace: string): Promise<void> {
    const carrier = this.carrier(workspace)
    const tree = await carrier.open()
    await materializeFiles(id => carrier.readPayload(id), tree)
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
    this.targets.delete(workspace)
    // Forget the remembered handles but never touch the user's folder or zip:
    // deleting their files would be data loss the trash contract never promised.
    await forgetWorkspaceHandle(workspace)
    await forgetWorkspaceZipHandle(workspace)
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

  // The one carrier-change compare. `reconcile` is opt-in because a folder
  // reconcile walks every entry, so only the explicit check pays for it.
  private async carrierCheck(workspace: string, reconcile: boolean): Promise<CarrierCheck> {
    const meta = await this.requireMeta(workspace)
    if (!isExternal(meta)) return { status: 'none' }
    const target = await this.target(workspace, meta, false)
    if (!target) return { status: 'unavailable', carrier: meta.carrier!.kind as 'folder' | 'zip' }
    const fingerprint = await target.readManifestFingerprint()
    const check: CarrierCheck = {
      status: meta.loadedFrom && fingerprint !== meta.loadedFrom.fingerprint ? 'changed' : 'clean',
      carrier: target.kind,
      label: target.label,
    }
    // A manifest-less folder has nothing to reconcile against; it is pending its
    // first save, and treating every file as an orphan would be noise.
    if (reconcile && fingerprint !== null && target.reconcile) check.reconcile = await target.reconcile()
    return check
  }

  // The concrete external target, resolved once and cached beside the carrier.
  // A null result is dropped rather than cached so a later Reopen can retry it.
  private async target(workspace: string, meta: WorkspaceMetaRecord, request: boolean): Promise<CarrierTarget | null> {
    const cached = this.targets.get(workspace)
    if (cached) return cached
    const resolved = await resolveCarrierTarget(workspace, meta, request)
    if (resolved) this.targets.set(workspace, resolved)
    return resolved
  }

  // Bind a picked folder or zip: remember the handle, build the target from it
  // directly (no permission probe on a handle the user just granted), and cache
  // it. The carrier itself is not written; the first explicit save is.
  private async bindTarget(workspace: string, binding: CarrierTargetBinding): Promise<CarrierTarget> {
    let target: CarrierTarget
    if (binding.kind === 'folder') {
      const handle = binding.handle as FileSystemDirectoryHandle
      await rememberWorkspaceHandle(workspace, handle)
      target = folderTarget(handle)
    } else {
      const handle = binding.handle as FileSystemFileHandle
      await rememberWorkspaceZipHandle(workspace, handle)
      let bytes = new Uint8Array(0)
      try {
        bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
      } catch {
        // A fresh zip file may not exist yet; the first save writes it.
      }
      target = zipTarget(handle, bytes)
    }
    this.targets.set(workspace, target)
    return target
  }

  // Seed `loadedFrom` from the bound target's current manifest, if it has one.
  // A manifest-less binding stays pending: no fingerprint prompt can fire
  // before the first save writes one.
  private async seedLoadedFrom(workspace: string): Promise<void> {
    const meta = await this.requireMeta(workspace)
    if (!isExternal(meta)) return
    const target = await this.target(workspace, meta, false)
    if (!target) return
    const fingerprint = await target.readManifestFingerprint()
    if (fingerprint === null) return
    await writeWorkspaceMeta({
      ...meta,
      loadedFrom: { carrier: target.kind, fingerprint, at: Date.now() },
    })
  }

  // Record the carrier's manifest as the state the working copy now agrees
  // with, clearing any durable divergence: this is the save-over resolution.
  private async recordLoadedFrom(workspace: string, target: CarrierTarget): Promise<void> {
    const meta = await this.requireMeta(workspace)
    const next: WorkspaceMetaRecord = { ...meta, carrierDiverged: false }
    const fingerprint = await target.readManifestFingerprint()
    if (fingerprint !== null) next.loadedFrom = { carrier: target.kind, fingerprint, at: Date.now() }
    else delete next.loadedFrom
    await writeWorkspaceMeta(next)
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

function isExternal(meta: WorkspaceMetaRecord): boolean {
  return meta.carrier !== undefined && meta.carrier.kind !== 'idb'
}

function bindingOf(binding: CarrierTargetBinding): CarrierBinding {
  const out: CarrierBinding = { kind: binding.kind }
  if (binding.label !== undefined) out.label = binding.label
  return out
}

// The working-copy rows a whole tree writes, one per manifest entry. Duplicate's
// copy and the carrier-change reload share it, so both land a tree the same way.
// Every payload must already be materialized: a document without text or a file
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
    records.push(record)
  }
  return records
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
