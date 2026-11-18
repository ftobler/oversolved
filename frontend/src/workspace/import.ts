import { parse as parseYaml } from 'yaml'
import type {
  EntryContent,
  ManifestEntry,
  ReferenceEdges,
  SerializedFile,
  WorkspaceEntry,
  WorkspaceManifest,
  WorkspaceTree,
} from './types'
import { MANIFEST_PATH, RESERVED_PREFIX, TRASH_DIR } from './paths'
import { emptyManifest, parseManifest, serializeManifest } from './manifest'
import { addEntry, createTree } from './tree'
import { addReference, canonicalizeReferences } from './refs'
import { deserializeTree } from './serializer'
import { readZipFiles } from './zipCarrier'
import { buildStepContent } from '@/stores/documentStore/stepImport'
import { randomId } from '@/utils/yamlMutations'
import { randomUuid } from '@/utils/randomUuid'
import { KNOWN_DOC_KINDS, inferDocKind, parseDocKind, type KnownDocKind } from './kinds'
import { getWorkspaceStore, type WorkspaceStore } from './store'
import { bytesToBase64, writePreview } from '@/stores/previewStore/capture'

// Adoption: bytes and text from anywhere (a dropped file, a folder, a zip, a
// legacy `.oversolved` bundle) become a workspace. The classifier parses first
// and never coerces: an unrecognized kind is a file, a STEP file is a file plus
// a synthesized part, and a document the bag cannot resolve references for is
// reported unattached rather than silently dangling.
//
// A bag is (path, bytes) and nothing else: an import is a plain copy, so the
// source's identity never reaches the destination (2026-11-16). `remapTree` is
// the one id re-mint pass, shared with WorkspaceStore.duplicate.

export interface BagItem {
  path: string
  bytes: Uint8Array
}

export interface ImportBag {
  items: BagItem[]
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
  // Paths the manifest named and the bag did not carry. The entry is skipped
  // and the rest of the bag still imports.
  missingPayloads: string[]
  // Present when the picked file was a STEP landed as an assembly (B1 or B2):
  // the ids the import wrote, and the shells/faces a split left outside every
  // solid (0 when the file held solids only). Absent for every other import.
  step?: {
    assemblyId: string
    partIds: string[]
    fileIds: string[]
    leftovers: number
  }
}

export interface ImportedTree {
  tree: WorkspaceTree
  manifestPresent: boolean
  skippedReserved: number
  synthesizedParts: number
  unattached: string[]
  unknownFiles: string[]
  missingPayloads: string[]
  // A legacy bundle's `<doc>.png` sidecars, keyed by the bag-local id of the
  // document each one pictures. They are NOT tree entries -- a preview is
  // derived data and cannot live in the workspace (I5) -- so they ride beside
  // the tree and land in the preview store, which is its own database.
  previews: Map<string, Uint8Array>
}

export interface RemapOptions {
  workspace: string
  mintIds: boolean
  extraEdges?: ReferenceEdges
}

export interface RemapResult {
  tree: WorkspaceTree
  idMap: Map<string, string>
}

export interface ImportOptions {
  into?: string
  // The new workspace's display name. Without it the name comes from the bag's
  // first document.
  name?: string
}

// Walk a picked directory into a bag. Every file is read, bookkeeping included:
// the classifier decides what is reserved, not the reader, so the count it
// reports is the bag's, not a walk artifact.
export async function readDirectoryBag(dir: FileSystemDirectoryHandle): Promise<ImportBag> {
  const items: BagItem[] = []
  await walk(dir, '', items)
  return { items }
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
export async function readZipBag(bytes: Uint8Array): Promise<ImportBag> {
  if (bytes.byteLength > MAX_BUNDLE_INPUT_BYTES) throw new Error('Archive is too large')
  const files = await readZipFiles(bytes)
  if (files.length > MAX_BUNDLE_ENTRIES) throw new Error('Archive contains too many files')
  return { items: files.map(file => ({ path: file.path, bytes: toBytes(file.data) })) }
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

// The manifest minus the rows whose payload the bag does not carry. Trash ids
// and reference edges naming a dropped row go with it: a pruned manifest that
// still pointed at one would describe an entry the tree cannot hold, and the
// edge would outlive its target.
function withoutEntries(
  manifest: WorkspaceManifest, present: Record<string, ManifestEntry>,
): WorkspaceManifest {
  const references: ReferenceEdges = {}
  for (const [from, targets] of Object.entries(manifest.references)) {
    if (!(from in present)) continue
    references[from] = targets.filter(to => to in present)
  }
  const pruned: WorkspaceManifest = {
    ...manifest,
    entries: present,
    references: canonicalizeReferences(references),
    trash: manifest.trash.filter(id => id in present),
  }
  // The cover names a row like the trash does, so a pruned row takes it with it;
  // the imported workspace falls back to the automatic choice instead of
  // carrying a dangling id.
  if (pruned.cover !== undefined && !(pruned.cover in present)) delete pruned.cover
  return pruned
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

function isYamlPath(path: string): boolean {
  return /\.(yaml|yml)$/i.test(path)
}

// The kind a loose bag item claims, or undefined when it is not a document. A
// stamped kind is the only answer when there is one, unknown kinds included: a
// `kind: drawing` payload is a file, not a part the shape guess talked itself
// into. Only a kind-less `.yaml` falls through to `inferDocKind`, the temporary
// shim over the export that never stamped one. The extension is the shim's
// second guard: a payload that neither names its kind nor is spelled like a
// document stays a file.
function documentKind(path: string, text: string): KnownDocKind | undefined {
  const stamped = parseDocKind(text)
  if (stamped !== undefined) {
    return (KNOWN_DOC_KINDS as readonly string[]).includes(stamped) ? stamped as KnownDocKind : undefined
  }
  return isYamlPath(path) ? inferDocKind(text) : undefined
}

// Parse-first classification of a bag into a tree with the bag's own ids. The
// remap pass that follows decides whether those ids survive (manifest present,
// landing new) or are re-minted (manifest absent, or joining a live workspace).
export function readBagTree(bag: ImportBag): ImportedTree {
  const detected = detectManifest(bag.items)
  const wrapper = detected?.wrapper ?? ''
  const { effective, skippedReserved } = collectEffectiveItems(bag.items, wrapper)
  return detected
    ? readManifestCarryingTree(detected, effective, skippedReserved)
    : readManifestlessTree(effective, skippedReserved)
}

// Drop the manifest row itself and every reserved-segment path except trash
// payloads, counting what was skipped. Trash payloads stay: they are a manifest
// entry's payload, not bookkeeping.
function collectEffectiveItems(
  items: BagItem[], wrapper: string,
): { effective: BagItem[]; skippedReserved: number } {
  const effective: BagItem[] = []
  let skippedReserved = 0
  for (const item of items) {
    const path = relative(item.path, wrapper)
    if (path === MANIFEST_PATH) continue
    if (path.split('/').some(segment => segment.startsWith(RESERVED_PREFIX))
      && !path.startsWith(`${TRASH_DIR}/`)) {
      skippedReserved++
      continue
    }
    effective.push({ path, bytes: item.bytes })
  }
  return { effective, skippedReserved }
}

// A manifest-carrying bag is the format's own export: match every named row to
// its payload, prune the rows the bag does not carry so the manifest describes
// only what the tree can hold, and adopt the unnamed leftovers as orphan file
// entries rather than dropping them.
function readManifestCarryingTree(
  detected: DetectedManifest,
  effective: BagItem[],
  skippedReserved: number,
): ImportedTree {
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
  // A named file the bag does not carry is skipped and reported, never fatal.
  // Rejecting the bag made one deleted payload cost every other document in
  // it, which is the opposite of how an unnamed file is treated further down.
  // The manifest is pruned to match, because a row whose payload is absent is
  // not an entry the tree can hold.
  const missingPayloads: string[] = []
  const present: Record<string, ManifestEntry> = {}
  for (const [id, row] of Object.entries(manifest.entries)) {
    const item = byPath.get(row.path) ?? byPath.get(`${TRASH_DIR}/${row.path}`)
    if (!item) {
      missingPayloads.push(row.path)
      continue
    }
    present[id] = row
    files.push({ path: row.path, data: item.bytes })
  }
  if (missingPayloads.length > 0) {
    files[0] = { path: MANIFEST_PATH, data: serializeManifest(withoutEntries(manifest, present)) }
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
    missingPayloads: missingPayloads.sort(),
    // A manifest-carrying bag is this format's own export, and I5 keeps every
    // preview out of it, so there is never a sidecar here to seed from.
    previews: new Map(),
  }
}

// Manifest-absent: the bag is a pile of sources, not a graph. Documents are
// classified first so a preview sidecar can be recognized and dropped. Each
// payload is classified once here and the verdict carried forward, so the shape
// guess below does not re-parse every document a second time.
function classifyLooseDocuments(effective: BagItem[]): Map<string, KnownDocKind> {
  const documentKinds = new Map<string, KnownDocKind>()
  for (const item of effective) {
    if (isStepPath(item.path) || isPngPath(item.path)) continue
    const kind = documentKind(item.path, decode(item.bytes))
    if (kind !== undefined) documentKinds.set(item.path, kind)
  }
  return documentKinds
}

interface LooseAdoption {
  synthesizedParts: number
  skippedSidecars: number
  sidecarBytes: Map<string, Uint8Array>  // document path -> png bytes
  documentIds: Map<string, string>  // document path -> entry id
}

// Add every loose payload to the tree, synthesizing a part around each STEP. A
// sidecar can precede its document, and the document's id is minted as it is
// classified, so the two halves are collected here and paired after the pass.
function adoptLooseItems(
  tree: WorkspaceTree,
  effective: BagItem[],
  documentKinds: Map<string, KnownDocKind>,
  documentPaths: Set<string>,
): LooseAdoption {
  let synthesizedParts = 0
  let skippedSidecars = 0
  const sidecarBytes = new Map<string, Uint8Array>()
  const documentIds = new Map<string, string>()
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
      skippedSidecars++
      continue
    }
    const text = isStepPath(item.path) ? undefined : decode(item.bytes)
    const docKind = documentKinds.get(item.path)
    if (text !== undefined && docKind !== undefined) {
      const entry = documentEntry(documentStem(item.path), text, docKind)
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
  return { synthesizedParts, skippedSidecars, sidecarBytes, documentIds }
}

// Documents whose text points at an entry the tree does not hold. Reported,
// never silently dropped.
function findUnattachedDocuments(tree: WorkspaceTree): string[] {
  const unattached: string[] = []
  for (const [id, row] of Object.entries(tree.manifest.entries)) {
    if (row.kind !== 'document') continue
    const text = tree.contents.get(id)?.text ?? ''
    if (extractReferenceIds(text).some(ref => tree.manifest.entries[ref] === undefined)) {
      unattached.push(id)
    }
  }
  return unattached
}

function pairPreviews(
  sidecarBytes: Map<string, Uint8Array>, documentIds: Map<string, string>,
): Map<string, Uint8Array> {
  const previews = new Map<string, Uint8Array>()
  for (const [documentPath, bytes] of sidecarBytes) {
    const id = documentIds.get(documentPath)
    if (id !== undefined) previews.set(id, bytes)
  }
  return previews
}

function readManifestlessTree(effective: BagItem[], skippedReserved: number): ImportedTree {
  const documentKinds = classifyLooseDocuments(effective)
  const documentPaths = new Set(documentKinds.keys())
  const tree = createTree(emptyManifest(randomUuid()))
  const adopted = adoptLooseItems(tree, effective, documentKinds, documentPaths)
  return {
    tree,
    manifestPresent: false,
    skippedReserved: skippedReserved + adopted.skippedSidecars,
    synthesizedParts: adopted.synthesizedParts,
    unattached: findUnattachedDocuments(tree).sort(),
    unknownFiles: [],
    // A bag with no manifest names no file it does not carry.
    missingPayloads: [],
    previews: pairPreviews(adopted.sidecarBytes, adopted.documentIds),
  }
}

// The kind is passed in rather than re-read from the text: the classifier may
// have inferred it from the shape, and a re-read would drop that back to the
// stamped kind the payload does not have.
function documentEntry(name: string, text: string, docKind: KnownDocKind): WorkspaceEntry {
  return {
    id: randomUuid(),
    kind: 'document',
    name,
    text,
    docKind,
  }
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

// Pure. Re-mint every entry id (when asked), then run references and trash
// through the resulting map in one pass. `extraEdges` is merged before the remap
// so a caller can author an edge whose endpoints are not yet in the tree.
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

  const trash = tree.manifest.trash
    .map(id => idMap.get(id))
    .filter((id): id is string => id !== undefined)

  const manifest: WorkspaceManifest = {
    format: tree.manifest.format,
    workspace: opts.workspace,
    entries,
    references: canonicalizeReferences(references),
    trash,
  }
  // The cover is a row reference like the trash, so it travels through the same
  // map and is dropped when the row it named was not remapped. A join does not
  // take it: mergeTrees leaves the destination's own choice standing.
  const cover = tree.manifest.cover === undefined ? undefined : idMap.get(tree.manifest.cover)
  if (cover !== undefined) manifest.cover = cover
  return { tree: { manifest, contents }, idMap }
}

// ─── landing ───

// Adopt a bag into a workspace. With `into` set, the bag joins that workspace
// under re-minted ids; without it, the bag becomes a new workspace (keeping its
// entry ids when it carried a manifest, which is what makes an archive reopen
// with the same identity).
export async function importBag(
  bag: ImportBag,
  opts: ImportOptions = {},
  store: WorkspaceStore = getWorkspaceStore(),
): Promise<ImportResult> {
  const imported = readBagTree(bag)
  return opts.into !== undefined
    ? joinWorkspace(opts.into, imported, store)
    : createWorkspace(imported, opts, store)
}

function countEntries(tree: WorkspaceTree): { documents: number; files: number } {
  const rows = Object.values(tree.manifest.entries)
  return {
    documents: rows.filter(row => row.kind === 'document').length,
    files: rows.filter(row => row.kind === 'file').length,
  }
}

function importResult(imported: ImportedTree, workspace: string, mode: 'new' | 'join'): ImportResult {
  return {
    workspace,
    mode,
    ...countEntries(imported.tree),
    synthesizedParts: imported.synthesizedParts,
    skippedReserved: imported.skippedReserved,
    unattached: imported.unattached,
    unknownFiles: imported.unknownFiles,
    missingPayloads: imported.missingPayloads,
  }
}

// Join an existing workspace. A manifest-present source re-mints its ids: they
// could collide with the destination. A manifest-less pile had every id minted
// fresh by this very read, so it cannot collide, and re-minting would only
// strand the references its synthesized documents carry in their TEXT (a STEP's
// part names its file by id there), which the remap does not rewrite.
async function joinWorkspace(
  workspace: string,
  imported: ImportedTree,
  store: WorkspaceStore,
): Promise<ImportResult> {
  const remapped = remapTree(imported.tree, {
    workspace,
    mintIds: imported.manifestPresent,
  })
  const destination = await store.open(workspace)
  mergeTrees(destination.tree, remapped.tree)
  await store.save(workspace, destination.tree)
  await seedPreviews(workspace, imported, remapped.idMap)
  return importResult(imported, workspace, 'join')
}

// The copy lands in the permanent store and the source is forgotten: the
// folder or archive it came out of is left exactly as it was found.
async function createWorkspace(
  imported: ImportedTree,
  opts: ImportOptions,
  store: WorkspaceStore,
): Promise<ImportResult> {
  const { workspace } = await store.create(opts.name ?? defaultWorkspaceName(imported.tree))
  try {
    const remapped = remapTree(imported.tree, {
      workspace,
      mintIds: false,
    })
    await store.land(workspace, remapped.tree)
    await seedPreviews(workspace, imported, remapped.idMap)
    return importResult(imported, workspace, 'new')
  } catch (e) {
    // The workspace row was the first write; a failed landing must not leave it
    // as an empty tile. Cleanup is best effort and never hides the real error.
    await store.purge(workspace).catch(() => {})
    throw e
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

function mergeTrees(destination: WorkspaceTree, source: WorkspaceTree): void {
  for (const [id, row] of Object.entries(source.manifest.entries)) destination.manifest.entries[id] = { ...row }
  for (const [id, content] of source.contents) destination.contents.set(id, content)
  for (const [from, targets] of Object.entries(source.manifest.references)) {
    const current = destination.manifest.references[from] ?? []
    destination.manifest.references[from] = [...new Set([...current, ...targets])].sort()
  }
  destination.manifest.trash.push(...source.manifest.trash)
}
