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
import { emptyManifest, parseManifest } from './manifest'
import { addEntry, createTree } from './tree'
import { addReference, canonicalizeReferences } from './refs'
import { deserializeTree } from './serializer'
import { readZipFiles } from './zipCarrier'
import { buildStepContent } from '@/stores/documentStore/stepImport'
import { randomId } from '@/utils/yamlMutations'
import { randomUuid } from '@/utils/randomUuid'
import { KNOWN_DOC_KINDS, parseDocKind } from './kinds'
import { getWorkspaceStore, type CarrierTargetBinding, type WorkspaceStore } from './store'

// Adoption: bytes and text from anywhere (a dropped file, a folder, a zip, a
// legacy `.oversolved` bundle) become a workspace. The classifier parses first
// and never coerces: an unrecognized kind is a file, a STEP file is a file plus
// a synthesized part, and a document the bag cannot resolve references for is
// reported unattached rather than silently dangling.
//
// The bag is origin-free by design: `origin` is threaded through untouched and
// only stamped onto each imported entry's provenance record. `remapTree` is the
// one id re-mint pass, shared with WorkspaceStore.duplicate and, later, with the
// C6 snapshot copy.

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
  origin: string
  name?: string
  // The folder or zip the touched, new workspace should save back to. Only the
  // new-workspace branch binds it; a join keeps the destination's target.
  target?: CarrierTargetBinding
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

function siblingDocument(path: string, documents: Set<string>): boolean {
  if (!isPngPath(path)) return false
  const base = path.slice(0, -'.png'.length)
  return documents.has(`${base}.yaml`) || documents.has(`${base}.yml`)
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
      if (siblingDocument(item.path, documentPaths)) {
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
  for (const item of effective) {
    if (siblingDocument(item.path, documentPaths)) {
      skippedReserved++
      continue
    }
    const text = isStepPath(item.path) ? undefined : decode(item.bytes)
    if (text !== undefined && isDocument(text)) {
      addEntry(tree, documentEntry(documentStem(item.path), text))
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

  return { tree, manifestPresent: false, skippedReserved, synthesizedParts, unattached: unattached.sort(), unknownFiles: [] }
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
  const documents = Object.values(imported.tree.manifest.entries).filter(row => row.kind === 'document').length
  const files = Object.values(imported.tree.manifest.entries).filter(row => row.kind === 'file').length

  if (opts.into !== undefined) {
    const remapped = remapTree(imported.tree, {
      workspace: opts.into,
      mintIds: true,
      origin: opts.origin,
    })
    stampProvenance(remapped.tree, opts.origin)
    const destination = await store.open(opts.into)
    mergeTrees(destination.tree, remapped.tree)
    await store.save(opts.into, destination.tree)
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
    origin: opts.origin,
  })
  stampProvenance(remapped.tree, opts.origin)
  // Landing writes the working copy only. A bound folder is left as it was on
  // disk (opening a 200-file folder must not rewrite 200 files); the first
  // explicit save normalizes the canonical layout.
  await store.land(workspace, remapped.tree)
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

function defaultWorkspaceName(tree: WorkspaceTree): string {
  for (const row of Object.values(tree.manifest.entries)) {
    if (row.kind === 'document') return row.name
  }
  return 'Imported'
}

function stampProvenance(tree: WorkspaceTree, origin: string): void {
  const byEntry = new Map(tree.manifest.provenance.map(record => [record.entry, record]))
  for (const id of Object.keys(tree.manifest.entries)) {
    const existing = byEntry.get(id)
    byEntry.set(id, existing ? { ...existing, origin } : { entry: id, origin })
  }
  tree.manifest.provenance = [...byEntry.values()]
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
