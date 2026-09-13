import { parse as parseYaml } from 'yaml'
import type {
  EntryContent,
  ManifestEntry,
  ProvenanceRecord,
  ReferenceEdges,
  SerializedFile,
  WorkspaceEntry,
  WorkspaceManifest,
  WorkspaceTree,
} from './types'
import { MANIFEST_PATH, RESERVED_PREFIX, TRASH_DIR } from './paths'
import { emptyManifest, parseManifest } from './manifest'
import { addEntry, createTree, putEntry } from './tree'
import { addReference, canonicalizeReferences } from './refs'
import { deserializeTree } from './serializer'
import { hashRecord } from './contentHash'
import { readZipFiles } from './zipCarrier'
import { buildStepContent } from '@/stores/documentStore/stepImport'
import { randomId } from '@/utils/yamlMutations'
import { randomUuid } from '@/utils/randomUuid'
import { KNOWN_DOC_KINDS, parseDocKind } from './kinds'
import { resolveOrigin, type OriginDescriptor, type OriginResolver } from './originResolver'
import { getWorkspaceStore, type CarrierTargetBinding, type WorkspaceStore } from './store'
import { bytesToBase64, writePreview } from '@/stores/previewStore/capture'

// Adoption: bytes and text from anywhere (a dropped file, a folder, a zip, a
// legacy `.oversolved` bundle) become a workspace. The classifier parses first
// and never coerces: an unrecognized kind is a file, a STEP file is a file plus
// a synthesized part, and a document the bag cannot resolve references for is
// reported unattached rather than silently dangling.
//
// The bag is identity-free by design: the structured origin descriptor is
// threaded through untouched and only stamped onto each imported entry's
// provenance record. A bag's own `origin` string is the C3 shape and is ignored
// by the classifier. `remapTree` is the one id re-mint pass, shared with
// WorkspaceStore.duplicate and, later, with the C6 snapshot copy.

export interface BagItem {
  path: string
  bytes: Uint8Array
}

export interface ImportBag {
  items: BagItem[]
  origin: string
}

export interface ImportResult {
  workspace: string
  mode: 'new' | 'join'
  documents: number
  files: number
  synthesizedParts: number
  skippedReserved: number
  unattached: string[]
  // Non-reserved bag paths the manifest did not name. They are adopted as
  // orphan file entries and listed here, never silently dropped.
  unknownFiles: string[]
}

export interface ImportedTree {
  tree: WorkspaceTree
  manifestPresent: boolean
  skippedReserved: number
  synthesizedParts: number
  unattached: string[]
  unknownFiles: string[]
  // A legacy bundle's `<doc>.png` sidecars, keyed by the bag-local id of the
  // document each one pictures. They are NOT tree entries -- a preview is
  // derived data and cannot live in the workspace (I5) -- so they ride beside
  // the tree and land in the preview store, which is its own database.
  previews: Map<string, Uint8Array>
}

export interface RemapOptions {
  workspace: string
  mintIds: boolean
  origin: string
  extraEdges?: ReferenceEdges
}

export interface RemapResult {
  tree: WorkspaceTree
  idMap: Map<string, string>
}

export interface ImportOptions {
  into?: string
  // The C3 seam, now structured. A bare locator string is still accepted for
  // the pre-C6 call shape and carries no same-session re-read.
  origin: OriginDescriptor | string
  name?: string
  // The folder or zip the touched, new workspace should save back to. Only the
  // new-workspace branch binds it; a join keeps the destination's target.
  target?: CarrierTargetBinding
}

function normalizeOrigin(origin: OriginDescriptor | string): OriginDescriptor {
  return typeof origin === 'string' ? { locator: origin } : origin
}

// Walk a picked directory into a bag. Every file is read, bookkeeping included:
// the classifier decides what is reserved, not the reader, so the count it
// reports is the bag's, not a walk artifact.
export async function readDirectoryBag(
  dir: FileSystemDirectoryHandle, origin: string,
): Promise<ImportBag> {
  const items: BagItem[] = []
  await walk(dir, '', items)
  return { items, origin }
}

async function walk(
  dir: FileSystemDirectoryHandle, prefix: string, out: BagItem[],
): Promise<void> {
  for await (const handle of dir.values()) {
    const path = prefix ? `${prefix}/${handle.name}` : handle.name
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile()
      out.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) })
      continue
    }
    await walk(handle as FileSystemDirectoryHandle, path, out)
  }
}

// Caps on a zip a user hands the app. The entry cap and the compressed-input
// cap were the old bundle reader's, kept because the risk is the same archive
// either way. The residual gap is unchanged: total decompressed size is not
// capped, because JSZip does not expose uncompressed sizes before decompression.
// A preview is derived decoration: the capture path writes a PNG capped at
// captureThumbnail's MAX_SIZE of 1024px, which lands well under this. A sidecar
// larger than that is not a thumbnail and is not worth persisting.
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024

export const MAX_BUNDLE_ENTRIES = 10000
export const MAX_BUNDLE_INPUT_BYTES = 100 * 1024 * 1024

// A zip is the same bag, whether it is a workspace archive (it carries a
// manifest) or a legacy `.oversolved` bundle (it does not). This reader is
// deliberately dumb: it hands every entry to the classifier, which owns the
// reserved and preview-sidecar rules and their counts.
export async function readZipBag(bytes: Uint8Array, origin: string): Promise<ImportBag> {
  if (bytes.byteLength > MAX_BUNDLE_INPUT_BYTES) throw new Error('Archive is too large')
  const files = await readZipFiles(bytes)
  if (files.length > MAX_BUNDLE_ENTRIES) throw new Error('Archive contains too many files')
  return { items: files.map(file => ({ path: file.path, bytes: toBytes(file.data) })), origin }
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

// ─── classifier ───

interface DetectedManifest {
  item: BagItem
  wrapper: string
}

function detectManifest(items: BagItem[]): DetectedManifest | null {
  const matches: DetectedManifest[] = []
  for (const item of items) {
    if (item.path === MANIFEST_PATH) {
      matches.push({ item, wrapper: '' })
      continue
    }
    if (item.path.endsWith(`/${MANIFEST_PATH}`)) {
      matches.push({ item, wrapper: item.path.slice(0, item.path.length - MANIFEST_PATH.length) })
    }
  }
  // A bag is one workspace or one bundle, never several. Refusing is the only
  // deterministic answer: picking one would depend on the order the walker
  // happened to yield, and the other manifest would be silently ignored.
  if (matches.length > 1) throw new Error(`Archive contains ${matches.length} manifests; expected at most one`)
  return matches[0] ?? null
}

function relative(path: string, wrapper: string): string {
  return wrapper && path.startsWith(wrapper) ? path.slice(wrapper.length) : path
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

// A picked file's display name: its filename without the document extension,
// because in a file-backed source the filename IS the name.
export function stemOf(fileName: string): string {
  const base = fileName.replace(/\.[^/.]*$/, '')
  return base || fileName
}

function documentStem(path: string): string {
  return stemOf(basename(path)).replace(/\.(yaml|yml)$/i, '') || basename(path)
}

function isStepPath(path: string): boolean {
  return /\.(step|stp)$/i.test(path)
}

function isPngPath(path: string): boolean {
  return /\.png$/i.test(path)
}

// The document a `<doc>.png` sits beside, or undefined when the png is not a
// sidecar. The path is returned rather than a boolean because the sidecar is a
// legacy library's thumbnail: the caller drops it from the tree (I5 -- no
// derived artifact is an entry) and seeds the preview store with it under the
// document it belongs to.
function siblingDocument(path: string, documents: Set<string>): string | undefined {
  if (!isPngPath(path)) return undefined
  const base = path.slice(0, -'.png'.length)
  for (const candidate of [`${base}.yaml`, `${base}.yml`]) {
    if (documents.has(candidate)) return candidate
  }
  return undefined
}

function inferMime(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml'
  return 'application/octet-stream'
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function isDocument(text: string): boolean {
  const kind = parseDocKind(text)
  return kind !== undefined && (KNOWN_DOC_KINDS as readonly string[]).includes(kind)
}

// Parse-first classification of a bag into a tree with the bag's own ids. The
// remap pass that follows decides whether those ids survive (manifest present,
// landing new) or are re-minted (manifest absent, or joining a live workspace).
export function readBagTree(bag: ImportBag): ImportedTree {
  const detected = detectManifest(bag.items)
  const wrapper = detected?.wrapper ?? ''
  let skippedReserved = 0

  const effective: BagItem[] = []
  for (const item of bag.items) {
    const path = relative(item.path, wrapper)
    if (path === MANIFEST_PATH) continue
    // The manifest is reserved but always parsed; every other reserved segment
    // is skipped and counted. Trash payloads stay: they are a manifest entry's
    // payload, not bookkeeping.
    if (path.split('/').some(segment => segment.startsWith(RESERVED_PREFIX))
      && !path.startsWith(`${TRASH_DIR}/`)) {
      skippedReserved++
      continue
    }
    effective.push({ path, bytes: item.bytes })
  }

  if (detected) {
    const manifest = parseManifest(decode(detected.item.bytes))
    const documentPaths = new Set(
      Object.values(manifest.entries).filter(row => row.kind === 'document').map(row => row.path),
    )
    const byPath = new Map<string, BagItem>()
    for (const item of effective) {
      if (siblingDocument(item.path, documentPaths) !== undefined) {
        skippedReserved++
        continue
      }
      byPath.set(item.path, item)
    }
    const files: SerializedFile[] = [{ path: MANIFEST_PATH, data: decode(detected.item.bytes) }]
    const named = new Set<string>()
    for (const row of Object.values(manifest.entries)) {
      named.add(row.path)
      // A trashed entry's payload may sit under the trash dir (a folder that had
      // a zip unzipped into it); both locations are the manifest's.
      named.add(`${TRASH_DIR}/${row.path}`)
    }
    for (const [id, row] of Object.entries(manifest.entries)) {
      const item = byPath.get(row.path) ?? byPath.get(`${TRASH_DIR}/${row.path}`)
      if (!item) throw new Error(`Manifest entry is missing its file: ${row.path} (${id})`)
      files.push({ path: row.path, data: item.bytes })
    }
    const tree = deserializeTree(files)
    // A bag path the manifest does not name is an orphan: adopt it as a file
    // entry so it is preserved, and report it, rather than dropping it on the
    // floor the way reading only the manifest would.
    const unknownFiles: string[] = []
    for (const [path, item] of byPath) {
      if (named.has(path)) continue
      addEntry(tree, {
        id: randomUuid(),
        kind: 'file',
        name: basename(path),
        mime: inferMime(path),
        bytes: item.bytes,
      })
      unknownFiles.push(path)
    }
    return {
      tree,
      manifestPresent: true,
      skippedReserved,
      synthesizedParts: 0,
      unattached: [],
      unknownFiles: unknownFiles.sort(),
      // A manifest-carrying bag is this format's own export, and I5 keeps every
      // preview out of it, so there is never a sidecar here to seed from.
      previews: new Map(),
    }
  }

  // Manifest-absent: the bag is a pile of sources, not a graph. Documents are
  // classified first so a preview sidecar can be recognized and dropped.
  const documentPaths = new Set<string>()
  for (const item of effective) {
    if (isStepPath(item.path) || isPngPath(item.path)) continue
    if (isDocument(decode(item.bytes))) documentPaths.add(item.path)
  }

  const tree = createTree(emptyManifest(randomUuid()))
  let synthesizedParts = 0
  // A sidecar can precede its document in the bag, and the document's id is
  // minted as it is classified, so the two halves are collected here and paired
  // after the pass rather than in it.
  const sidecarBytes = new Map<string, Uint8Array>()  // document path -> png bytes
  const documentIds = new Map<string, string>()  // document path -> entry id
  for (const item of effective) {
    const pictured = siblingDocument(item.path, documentPaths)
    if (pictured !== undefined) {
      // Dropped from the tree and counted exactly as before; the bytes are kept
      // only to seed the preview store, which is not part of the workspace.
      // A thumbnail is a thumbnail. Without a cap a bag could carry a 90MB PNG
      // under the archive limit, and adoption would base64 it (+33%), persist
      // it, and later inline it into the DOM as a data: URI. Before D6 the
      // bytes were dropped, so the cap is what keeps that unchanged: an
      // oversized sidecar is skipped exactly as it used to be.
      if (item.bytes.byteLength <= MAX_PREVIEW_BYTES) sidecarBytes.set(pictured, item.bytes)
      skippedReserved++
      continue
    }
    const text = isStepPath(item.path) ? undefined : decode(item.bytes)
    if (text !== undefined && isDocument(text)) {
      const entry = documentEntry(documentStem(item.path), text)
      addEntry(tree, entry)
      documentIds.set(item.path, entry.id)
      continue
    }
    if (isStepPath(item.path)) {
      const fileId = randomUuid()
      addEntry(tree, {
        id: fileId,
        kind: 'file',
        name: basename(item.path),
        mime: 'application/step',
        fileKind: 'step',
        bytes: item.bytes,
      })
      const partId = randomUuid()
      addEntry(tree, {
        id: partId,
        kind: 'document',
        name: documentStem(item.path),
        docKind: 'part',
        text: buildStepContent(fileId, randomId(18), basename(item.path)),
      })
      addReference(tree, partId, fileId)
      synthesizedParts++
      continue
    }
    addEntry(tree, {
      id: randomUuid(),
      kind: 'file',
      name: basename(item.path),
      mime: inferMime(item.path),
      bytes: item.bytes,
    })
  }

  const unattached: string[] = []
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'document') continue
    const text = tree.contents.get(id)?.text ?? ''
    if (extractReferenceIds(text).some(ref => tree.manifest.entries[ref] === undefined)) {
      unattached.push(id)
    }
  }

  const previews = new Map<string, Uint8Array>()
  for (const [documentPath, bytes] of sidecarBytes) {
    const id = documentIds.get(documentPath)
    if (id !== undefined) previews.set(id, bytes)
  }

  return {
    tree,
    manifestPresent: false,
    skippedReserved,
    synthesizedParts,
    unattached: unattached.sort(),
    unknownFiles: [],
    previews,
  }
}

function documentEntry(name: string, text: string): WorkspaceEntry {
  const entry: WorkspaceEntry = {
    id: randomUuid(),
    kind: 'document',
    name,
    text,
  }
  const kind = parseDocKind(text)
  if (kind !== undefined) entry.docKind = kind
  return entry
}

// Every uuid a document's content points at, across both reference classes a
// loose document can carry: an `import_step` file id and a part instance's
// `doc_id`. The bag-wide remap cannot resolve either against freshly minted
// entries, so they are reported.
export function extractReferenceIds(text: string): string[] {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const features = (raw as Record<string, unknown>).features
  if (!Array.isArray(features)) return []
  const ids = new Set<string>()
  for (const value of features) {
    if (!value || typeof value !== 'object') continue
    const feature = value as Record<string, unknown>
    if (feature.kind === 'import_step' && typeof feature.file_id === 'string' && feature.file_id) {
      ids.add(feature.file_id)
    }
    if (feature.kind === 'part_instance' && feature.instance && typeof feature.instance === 'object') {
      const docId = (feature.instance as Record<string, unknown>).doc_id
      if (typeof docId === 'string' && docId) ids.add(docId)
    }
  }
  return [...ids]
}

// ─── the remap pass ───

// Pure. Re-mint every entry id (when asked), then run references, provenance and
// trash through the resulting map in one pass. `extraEdges` is merged before the
// remap so a caller can author an edge whose endpoints are not yet in the tree.
export function remapTree(tree: WorkspaceTree, opts: RemapOptions): RemapResult {
  const idMap = new Map<string, string>()
  for (const id of Object.keys(tree.manifest.entries)) {
    idMap.set(id, opts.mintIds ? randomUuid() : id)
  }

  const entries: Record<string, ManifestEntry> = {}
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    entries[idMap.get(id)!] = { ...row }
  }

  const contents = new Map<string, EntryContent>()
  for (const [id, content] of tree.contents) {
    const next = idMap.get(id)
    if (!next) continue
    contents.set(next, content.bytes !== undefined
      ? { bytes: new Uint8Array(content.bytes) }
      : { text: content.text })
  }

  const sources: ReferenceEdges = {}
  for (const [from, targets] of Object.entries({ ...tree.manifest.references, ...opts.extraEdges })) {
    sources[from] = [...(sources[from] ?? []), ...(targets ?? [])]
  }
  const references: ReferenceEdges = {}
  for (const [from, targets] of Object.entries(sources)) {
    const mappedFrom = idMap.get(from) ?? from
    references[mappedFrom] = targets.map(to => idMap.get(to) ?? to)
  }

  const provenance = tree.manifest.provenance
    .filter(record => idMap.has(record.entry))
    .map(record => ({ ...record, entry: idMap.get(record.entry)! }))

  const trash = tree.manifest.trash
    .map(id => idMap.get(id))
    .filter((id): id is string => id !== undefined)

  const manifest: WorkspaceManifest = {
    format: tree.manifest.format,
    workspace: opts.workspace,
    entries,
    references: canonicalizeReferences(references),
    provenance,
    trash,
  }
  return { tree: { manifest, contents }, idMap }
}

// ─── landing ───

// Adopt a bag into a workspace. With `into` set, the bag joins that workspace
// under re-minted ids; without it, the bag becomes a new workspace (keeping its
// entry ids when it carried a manifest, which is what makes an archive reopen
// with the same identity).
export async function importBag(
  bag: ImportBag,
  opts: ImportOptions,
  store: WorkspaceStore = getWorkspaceStore(),
): Promise<ImportResult> {
  const imported = readBagTree(bag)
  const descriptor = normalizeOrigin(opts.origin)
  const documents = Object.values(imported.tree.manifest.entries).filter(row => row.kind === 'document').length
  const files = Object.values(imported.tree.manifest.entries).filter(row => row.kind === 'file').length

  if (opts.into !== undefined) {
    const remapped = remapTree(imported.tree, {
      workspace: opts.into,
      mintIds: true,
      origin: descriptor.locator,
    })
    stampProvenance(remapped.tree, descriptor, imported, remapped.idMap)
    const destination = await store.open(opts.into)
    mergeTrees(destination.tree, remapped.tree)
    await store.save(opts.into, destination.tree)
    await seedPreviews(opts.into, imported, remapped.idMap)
    return {
      workspace: opts.into,
      mode: 'join',
      documents,
      files,
      synthesizedParts: imported.synthesizedParts,
      skippedReserved: imported.skippedReserved,
      unattached: imported.unattached,
      unknownFiles: imported.unknownFiles,
    }
  }

  const { workspace } = await store.create(opts.name ?? defaultWorkspaceName(imported.tree), { target: opts.target })
  const remapped = remapTree(imported.tree, {
    workspace,
    mintIds: false,
    origin: descriptor.locator,
  })
  stampProvenance(remapped.tree, descriptor, imported, remapped.idMap)
  // Landing writes the working copy only. A bound folder is left as it was on
  // disk (opening a 200-file folder must not rewrite 200 files); the first
  // explicit save normalizes the canonical layout.
  await store.land(workspace, remapped.tree)
  await seedPreviews(workspace, imported, remapped.idMap)
  return {
    workspace,
    mode: 'new',
    documents,
    files,
    synthesizedParts: imported.synthesizedParts,
    skippedReserved: imported.skippedReserved,
    unattached: imported.unattached,
    unknownFiles: imported.unknownFiles,
  }
}

// The adoption half of D6: a legacy bundle's `<doc>.png` sidecars become the
// imported documents' previews instead of being discarded. They are written to
// the preview store, keyed by the landing workspace and the LOCAL entry id, so
// the workspace tree never gains a derived artifact (I5) and the row that will
// show the thumbnail reads the same key a save writes. Best-effort throughout:
// a preview is derived data, and losing one must never fail an import.
async function seedPreviews(
  workspace: string, imported: ImportedTree, idMap: Map<string, string>,
): Promise<void> {
  for (const [bagId, bytes] of imported.previews) {
    const entry = idMap.get(bagId)
    if (entry === undefined) continue
    await writePreview(workspace, entry, bytesToBase64(bytes))
  }
}

function defaultWorkspaceName(tree: WorkspaceTree): string {
  for (const row of Object.values(tree.manifest.entries)) {
    if (row.kind === 'document') return row.name
  }
  return 'Imported'
}

// The id-mint seam. `idMap` already holds origin entry id -> local entry id
// (identity when the bag landed new with a manifest, a fresh remap on a join),
// so this records the mapping durably and keys it on the ORIGIN entry id. The
// hash is the source content's, never the local copy's, so a local edit cannot
// masquerade as an upstream move. Nested provenance the bag carried is remapped
// by remapTree and then overwritten here: the source just copied from is the
// direct upstream.
function stampProvenance(
  tree: WorkspaceTree,
  descriptor: OriginDescriptor,
  imported: ImportedTree,
  idMap: Map<string, string>,
): void {
  const copiedAt = Date.now()
  // Every record of one import shares a group, so a later update of one copy can
  // tell it apart from another copy of the same source (A8).
  const group = randomUuid()
  // A manifest-present source names its own workspace; a manifest-less pile has
  // only a per-read random id, so it carries none and cannot be group-matched.
  const sourceWorkspace = imported.manifestPresent ? imported.tree.manifest.workspace : descriptor.workspace
  const records: ProvenanceRecord[] = []
  for (const [oldId, content] of imported.tree.contents) {
    const localId = idMap.get(oldId)
    if (localId === undefined) continue
    const row = imported.tree.manifest.entries[oldId]
    if (!row) continue
    const record: ProvenanceRecord = {
      entry: localId,
      origin: descriptor.locator,
      originEntry: oldId,
      originGroup: group,
      hash: hashRecord({ kind: row.kind, text: content.text, bytes: content.bytes }),
      copiedAt,
    }
    if (descriptor.name !== undefined) record.originName = descriptor.name
    if (sourceWorkspace !== undefined) record.originWorkspace = sourceWorkspace
    records.push(record)
  }
  tree.manifest.provenance = records
}

function mergeTrees(destination: WorkspaceTree, source: WorkspaceTree): void {
  for (const [id, row] of Object.entries(source.manifest.entries)) destination.manifest.entries[id] = { ...row }
  for (const [id, content] of source.contents) destination.contents.set(id, content)
  for (const [from, targets] of Object.entries(source.manifest.references)) {
    const current = destination.manifest.references[from] ?? []
    destination.manifest.references[from] = [...new Set([...current, ...targets])].sort()
  }
  destination.manifest.provenance.push(...source.manifest.provenance.map(record => ({ ...record })))
  destination.manifest.trash.push(...source.manifest.trash)
}

// ─── the update path ───

export type OriginStatus = 'current' | 'changed' | 'unreachable' | 'not-updatable'

export interface OriginState {
  status: OriginStatus
  // True when the local copy's payload hash no longer matches the source hash
  // recorded at copy time. Computed from local data only, so the panel can show
  // it before any check without reading the source.
  editedLocally: boolean
}

export interface UpdateResult {
  updated: number
  added: number
  unreachable: boolean
  sourceMissing: boolean
}

// The status half of the origin read. `localHash` is the local entry's current
// contentHash; it never causes a resolver read, it only feeds `editedLocally`.
// The resolver read itself is the update gesture, the only caller of
// resolveOrigin outside the import gesture (I2).
export async function originState(
  record: ProvenanceRecord,
  localHash?: string,
  resolver?: OriginResolver,
): Promise<OriginState> {
  const editedLocally = record.hash !== undefined && localHash !== undefined && localHash !== record.hash
  // A record with no source entry id has nothing to correlate on: it is a
  // pre-C6 copy whose source key was never written. Reporting it as not
  // updatable keeps the panel from offering a pull that can only no-op. No
  // resolver read is needed to say so; a manifest-less pile keeps a source id
  // that never matches and surfaces as sourceMissing on the update itself.
  if (record.originEntry === undefined) return { status: 'not-updatable', editedLocally }
  const source = resolver ? await resolver.resolve(record.origin) : await resolveOrigin(record.origin)
  if (!source) return { status: 'unreachable', editedLocally }
  const originEntry = record.originEntry
  const sourceRow = source.manifest.entries[originEntry]
  const sourceContent = source.contents.get(originEntry)
  // A missing source entry is a status, never a delete: the local copy stays
  // (U4's guard owns deleting a referenced entry).
  if (!sourceRow || !sourceContent) return { status: 'changed', editedLocally }
  const hash = hashRecord({ kind: sourceRow.kind, text: sourceContent.text, bytes: sourceContent.bytes })
  return { status: record.hash !== undefined && hash === record.hash ? 'current' : 'changed', editedLocally }
}

// The explicit pull. It re-runs C3's snapshot-inward copy over the transitive
// closure of the clicked origin entry: every entry the source root reaches is
// overwritten in place (or added on first sight), with its outgoing edges
// translated through an origin-entry -> local-entry map that reuses existing
// provenance where it can and mints only for entries never seen before. Local
// edits to the copy are overwritten by design; entries outside the closure are
// untouched; entries the source no longer references are left in place. Nothing
// is written when the origin is unreachable, the source entry is gone, or the
// closure is already byte-identical to the source.
export async function updateFromOrigin(
  workspace: string,
  localRoot: string,
  resolver?: OriginResolver,
  store: WorkspaceStore = getWorkspaceStore(),
): Promise<UpdateResult> {
  // Read the record, resolve the (possibly slow) source, then open the tree the
  // pull writes. Opening after the resolve means a local edit made while the
  // source was being read lands in the tree the update runs on instead of being
  // clobbered by the whole-snapshot save. The residual window is the open-to-
  // save span below; it only overwrites the clicked copy's closure by design.
  const probe = await store.open(workspace)
  const record = probe.tree.manifest.provenance.find(candidate => candidate.entry === localRoot)
  if (!record) return { updated: 0, added: 0, unreachable: false, sourceMissing: true }

  const source = resolver ? await resolver.resolve(record.origin) : await resolveOrigin(record.origin)
  if (!source) return { updated: 0, added: 0, unreachable: true, sourceMissing: false }

  const originRoot = record.originEntry
  const sourceRoot = originRoot !== undefined ? source.manifest.entries[originRoot] : undefined
  // A missing source entry is a status, never a delete: the local copy stays
  // (U4's guard owns deleting a referenced entry). A manifest-less source mints
  // fresh ids on every read, so its recorded originEntry never matches here and
  // it is treated as not updatable instead of silently duplicating.
  if (!sourceRoot || !originRoot) return { updated: 0, added: 0, unreachable: false, sourceMissing: true }

  const opened = await store.open(workspace)
  const tree = opened.tree
  const closure = transitiveClosure(source, originRoot)
  // Scope the lookup to the clicked copy's import group. Two imports of one
  // source each hold the same origin entry ids under different local ids; the
  // group is what keeps the other copy's parts out of this map. A legacy record
  // with no group matches only other ungrouped records, and gets a group of its
  // own when this update restamps the closure (below).
  const group = record.originGroup
  const existing = new Map<string, string>()
  for (const other of tree.manifest.provenance) {
    if (other.origin !== record.origin || other.originEntry === undefined) continue
    if (group !== undefined ? other.originGroup !== group : other.originGroup !== undefined) continue
    if (!existing.has(other.originEntry)) existing.set(other.originEntry, other.entry)
  }
  const stampGroup = group ?? randomUuid()

  const originToLocal = new Map<string, string>([[originRoot, localRoot]])
  for (const originId of closure) {
    if (originId === originRoot) continue
    originToLocal.set(originId, existing.get(originId) ?? randomUuid())
  }

  // The local hashes answer "did the local copy drift" for files too, whose
  // bytes the opened tree leaves lazy. `previous.hash` is the source hash at
  // last copy, so equal hashes plus an equal local hash mean this entry needs no
  // write at all; restamping copiedAt would churn the carrier for nothing.
  const localHashes = new Map((await store.listEntries(workspace)).map(meta => [meta.id, meta.contentHash]))
  const copiedAt = Date.now()
  const provenance = new Map(tree.manifest.provenance.map(entry => [entry.entry, entry]))
  let updated = 0
  let added = 0

  for (const originId of closure) {
    const sourceRow = source.manifest.entries[originId]
    const sourceContent = source.contents.get(originId)
    if (!sourceRow || !sourceContent) continue
    const localId = originToLocal.get(originId)!
    const existed = tree.manifest.entries[localId] !== undefined
    const sourceHash = hashRecord({ kind: sourceRow.kind, text: sourceContent.text, bytes: sourceContent.bytes })
    const targets = [...new Set((source.manifest.references[originId] ?? [])
      .map(to => originToLocal.get(to))
      .filter((to): to is string => to !== undefined))].sort()
    const previous = provenance.get(localId)
    const unchanged = existed
      && previous?.hash === sourceHash
      && localHashes.get(localId) === sourceHash
      && sameTargets(tree.manifest.references[localId], targets)
    if (unchanged) continue

    const entry: WorkspaceEntry = { id: localId, kind: sourceRow.kind, name: sourceRow.name }
    if (sourceRow.docKind !== undefined) entry.docKind = sourceRow.docKind
    if (sourceRow.mime !== undefined) entry.mime = sourceRow.mime
    if (sourceRow.fileKind !== undefined) entry.fileKind = sourceRow.fileKind
    if (sourceContent.text !== undefined) entry.text = sourceContent.text
    if (sourceContent.bytes !== undefined) entry.bytes = new Uint8Array(sourceContent.bytes)
    // putEntry keeps an existing entry's path (path is display, I3) and derives
    // a unique one for an entry pulled in anew.
    putEntry(tree, entry)
    if (existed) updated++
    else added++

    if (targets.length > 0) tree.manifest.references[localId] = targets
    else delete tree.manifest.references[localId]

    const next: ProvenanceRecord = {
      entry: localId,
      origin: record.origin,
      originEntry: originId,
      originGroup: stampGroup,
      hash: sourceHash,
      copiedAt,
    }
    if (record.originName !== undefined) next.originName = record.originName
    if (source.manifest.workspace !== undefined) next.originWorkspace = source.manifest.workspace
    provenance.set(localId, next)
  }

  // Nothing changed: leave the carrier, the checkpoint and copiedAt untouched.
  if (updated === 0 && added === 0) return { updated: 0, added: 0, unreachable: false, sourceMissing: false }

  tree.manifest.provenance = [...provenance.values()]
  await store.save(workspace, tree)
  return { updated, added, unreachable: false, sourceMissing: false }
}

function sameTargets(current: string[] | undefined, next: string[]): boolean {
  const list = current ?? []
  if (list.length !== next.length) return false
  for (let i = 0; i < list.length; i++) {
    if (list[i] !== next[i]) return false
  }
  return true
}

// The transitive closure of one source entry over its reference edges, existing
// entries only. This is A8's unit of copy: an imported assembly brings the parts
// it references, and an update pulls the same set.
function transitiveClosure(tree: WorkspaceTree, root: string): string[] {
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    if (tree.manifest.entries[id] === undefined) continue
    seen.add(id)
    for (const to of tree.manifest.references[id] ?? []) {
      if (!seen.has(to)) stack.push(to)
    }
  }
  return [...seen].sort()
}
