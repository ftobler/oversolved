import { describe, it, expect, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { buildZipBytes } from '../zipCarrier'
import { serializeTree } from '../serializer'
import { readZipBag, readBagTree, readDirectoryBag, importBag, extractReferenceIds, type ImportBag } from '../import'
import { addReference } from '../refs'
import { TRASH_DIR } from '../paths'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'
import { MemoryDirectory } from '@/stores/documentStore/memoryDirectory'

// Adoption: the classifier's parse-first rules and the two landing modes. These
// run against the real IndexedDB workspace seam, so an import is asserted by
// what a later listEntries sees, not by what a fake received.

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, data] of Object.entries(files)) zip.file(path, data)
  return zip.generateAsync({ type: 'uint8array' })
}

function bag(path: string, bytes: Uint8Array | string, origin = 'test'): ImportBag {
  return {
    origin,
    items: [{ path, bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes }],
  }
}

const ASSEMBLY = [
  'kind: assembly',
  'features:',
  '  - id: f1',
  '    kind: part_instance',
  '    instance:',
  '      handle: h1',
  '      doc_id: missing-part',
  '      doc_rev: 1',
  '',
].join('\n')

describe('adoption: manifest absent', () => {
  beforeEach(resetWorkspaceIdb)

  it('a bare .yaml adopts into a new workspace and its entry id survives reopen', async () => {
    const store = new IdbWorkspaceStore()
    const result = await importBag(bag('Box.yaml', 'kind: part\n# body\n'), { origin: 'drop' }, store)
    expect(result.mode).toBe('new')
    expect(result.documents).toBe(1)

    const before = await store.listEntries(result.workspace)
    expect(before).toHaveLength(1)
    const after = await store.listEntries(result.workspace)
    expect(after[0].id).toBe(before[0].id)
  })

  it('classifies a hand-assembled zip into a document, a synthesized STEP part and an orphan', async () => {
    const bytes = await zipOf({
      'u/Part.yaml': 'kind: part\n',
      'u/model.step': new Uint8Array([0x49, 0x53, 0x4f]),
      'u/photo.jpeg': new Uint8Array([0xff, 0xd8, 0xff]),
    })
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'zip'), { origin: 'zip' }, store)

    expect(result.documents).toBe(2)  // the source part and the synthesized part
    expect(result.files).toBe(2)  // the STEP bytes and the orphan jpeg
    expect(result.synthesizedParts).toBe(1)

    const entries = await store.listEntries(result.workspace)
    expect(entries.find(e => e.name === 'photo.jpeg')).toMatchObject({ kind: 'file', mime: 'image/jpeg' })
    expect(entries.find(e => e.name === 'model.step')).toMatchObject({ kind: 'file', fileKind: 'step' })
    expect(entries.find(e => e.name === 'Part')).toMatchObject({ kind: 'document', docKind: 'part' })
  })

  it('an unrecognized kind adopts as a file under its mime, not a coerced part', async () => {
    const store = new IdbWorkspaceStore()
    const result = await importBag(bag('widget.yaml', 'kind: gizmo\n'), { origin: 'drop' }, store)
    const [entry] = await store.listEntries(result.workspace)
    expect(entry).toMatchObject({ kind: 'file', mime: 'application/yaml' })
    expect(entry.docKind).toBeUndefined()
  })

  it('a .yaml that does not parse adopts as a file under application/yaml', async () => {
    const store = new IdbWorkspaceStore()
    const result = await importBag(bag('broken.yaml', ': : not a mapping\n'), { origin: 'drop' }, store)
    const [entry] = await store.listEntries(result.workspace)
    expect(entry).toMatchObject({ kind: 'file', mime: 'application/yaml' })
  })

  it('a legacy .oversolved bundle adopts every document with a dangling reference', async () => {
    const bytes = await zipOf({
      'user/Asm.yaml': ASSEMBLY,
      'user/Box.yaml': 'kind: part\n',
      'user/Box.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'legacy'), { origin: 'legacy' }, store)

    expect(result.documents).toBe(2)
    // The preview sidecar is dropped and counted, never classified.
    expect(result.skippedReserved).toBe(1)
    // The assembly's doc_id names a uuid the bag does not contain.
    expect(result.unattached).toHaveLength(1)
    const entries = await store.listEntries(result.workspace)
    expect(entries.filter(e => e.kind === 'document')).toHaveLength(2)
    expect(entries.some(e => e.name === 'Box.png')).toBe(false)
  })

  it('the classifier drops the png sibling of a classified document with a count', async () => {
    const parsed = readBagTree(bag('diagram.yaml', 'kind: part\n'))
    expect(parsed.skippedReserved).toBe(0)
    const bytes = await zipOf({
      'u/diagram.yaml': 'kind: part\n',
      'u/diagram.png': new Uint8Array([1]),
    })
    const withSidecar = readBagTree(await readZipBag(bytes, 'zip'))
    expect(withSidecar.skippedReserved).toBe(1)
    expect(withSidecar.tree.manifest.entries && Object.values(withSidecar.tree.manifest.entries)
      .some(row => row.name === 'diagram.png')).toBe(false)
  })

  it('a stray png with no sibling document is kept as a file', async () => {
    const bytes = await zipOf({ 'u/logo.png': new Uint8Array([1, 2, 3]) })
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'zip'), { origin: 'zip' }, store)
    const [entry] = await store.listEntries(result.workspace)
    expect(entry).toMatchObject({ kind: 'file', mime: 'image/png' })
  })

  it('skips a reserved bookkeeping file and counts it, never adopting it as an entry', () => {
    const parsed = readBagTree({
      origin: 'folder',
      items: [
        { path: '.oversolved-index.json', bytes: new TextEncoder().encode('{}') },
        { path: 'Box.yaml', bytes: new TextEncoder().encode('kind: part\n') },
      ],
    })
    expect(parsed.skippedReserved).toBe(1)
    const names = Object.values(parsed.tree.manifest.entries).map(row => row.name)
    expect(names).toEqual(['Box'])
  })

  it('reads no references out of unparseable text instead of throwing', () => {
    expect(extractReferenceIds('[unparseable\n')).toEqual([])
  })
})

describe('adoption: a picked directory', () => {
  it('walks nested subdirectories and reads every file, bookkeeping included', async () => {
    const root = new MemoryDirectory('library')
    const top = await root.getFileHandle('Top.yaml', { create: true })
    const topWriter = await top.createWritable()
    await topWriter.write('kind: part\n')
    await topWriter.close()

    const sub = await root.getDirectoryHandle('nested', { create: true })
    const inner = await sub.getFileHandle('inner.step', { create: true })
    const writable = await inner.createWritable()
    await writable.write(new Uint8Array([1, 2, 3]))
    await writable.close()

    const bag = await readDirectoryBag(root as unknown as FileSystemDirectoryHandle, 'folder')
    expect(bag.items.map(item => item.path).sort()).toEqual(['Top.yaml', 'nested/inner.step'])
    expect(bag.origin).toBe('folder')
  })
})

describe('adoption: manifest present', () => {
  beforeEach(resetWorkspaceIdb)

  function sourceTree() {
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      fileEntry('b', 'b.step', bytesOf([1, 2, 3]), 'application/step'),
    ], 'source-ws')
    addReference(tree, 'a', 'b')
    return tree
  }

  it('landing new keeps the archive entry ids and re-mints the workspace id', async () => {
    const bytes = await buildZipBytes(sourceTree())
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws' }, store)

    expect(result.workspace).not.toBe('source-ws')
    const ids = (await store.listEntries(result.workspace)).map(entry => entry.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('joining a live workspace re-mints every id and remaps the reference edges', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Destination', { docKind: 'assembly' })
    const bytes = await buildZipBytes(sourceTree())
    const result = await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws', into: workspace }, store)
    expect(result.mode).toBe('join')

    const entries = await store.listEntries(workspace)
    const source = entries.filter(entry => entry.name === 'A' || entry.name === 'b.step')
    expect(source).toHaveLength(2)
    expect(source.map(entry => entry.id)).not.toContain('a')
    expect(source.map(entry => entry.id)).not.toContain('b')
  })

  it('importing an archive into its origin yields two of everything, not a no-op', async () => {
    const tree = sourceTree()
    const bytes = await buildZipBytes(tree)
    const store = new IdbWorkspaceStore()
    // Seed the origin workspace with the same tree, then import the archive into it.
    const created = await store.create('Origin', { docKind: 'part' })
    await store.save(created.workspace, tree)

    const before = await store.listEntries(created.workspace)
    expect(before).toHaveLength(2)
    await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws', into: created.workspace }, store)
    const after = await store.listEntries(created.workspace)
    expect(after).toHaveLength(4)
  })

  it('refuses a manifest that does not parse, by name', async () => {
    const bytes = await zipOf({ '.oversolved-manifest.yaml': ': : not yaml\n' })
    const store = new IdbWorkspaceStore()
    await expect(importBag(await readZipBag(bytes, 'bad'), { origin: 'bad' }, store))
      .rejects.toThrow(/Manifest/)
  })

  it('adopts a bag path the manifest does not name as a reported orphan', async () => {
    const files: Record<string, string | Uint8Array> = {}
    for (const file of serializeTree(sourceTree())) files[file.path] = file.data
    files['files/extra.bin'] = new Uint8Array([9, 9, 9])
    const bytes = await zipOf(files)

    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws' }, store)

    expect(result.unknownFiles).toEqual(['files/extra.bin'])
    const entries = await store.listEntries(result.workspace)
    expect(entries.find(entry => entry.name === 'extra.bin')).toMatchObject({ kind: 'file' })
  })

  // The tolerance used to run one way only: a file the manifest does not name
  // is adopted and reported, but a file it names and cannot find rejected the
  // whole bag, so one deleted payload cost every other document in the archive.
  it('skips a manifest entry whose file is gone and imports the rest', async () => {
    const files: Record<string, string | Uint8Array> = {}
    for (const file of serializeTree(sourceTree())) files[file.path] = file.data
    delete files['files/b.step']
    const bytes = await zipOf(files)

    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(bytes, 'ws'), { origin: 'ws' }, store)

    expect(result.missingPayloads).toEqual(['files/b.step'])
    expect(result.documents).toBe(1)
    const entries = await store.listEntries(result.workspace)
    expect(entries.map(entry => entry.name)).toEqual(['A'])
  })

  it('drops the reference edge to a skipped entry rather than leaving it dangling', async () => {
    const files: Record<string, string | Uint8Array> = {}
    for (const file of serializeTree(sourceTree())) files[file.path] = file.data
    delete files['files/b.step']
    const parsed = readBagTree(await readZipBag(await zipOf(files), 'ws'))

    expect(parsed.tree.manifest.entries.b).toBeUndefined()
    expect(parsed.tree.manifest.references.a ?? []).not.toContain('b')
  })

  it('reports nothing missing when every named file is present', async () => {
    const files: Record<string, string | Uint8Array> = {}
    for (const file of serializeTree(sourceTree())) files[file.path] = file.data
    const parsed = readBagTree(await readZipBag(await zipOf(files), 'ws'))
    expect(parsed.missingPayloads).toEqual([])
  })

  // A folder or zip that wraps the archive in a directory (a zip unzipped into
  // its own folder) is the same archive one level down: the wrapper prefix is
  // rebased off every path, not treated as part of the tree.
  it('lands a wrapped archive by rebasing the manifest and every payload path', async () => {
    const files: Record<string, string | Uint8Array> = {}
    for (const file of serializeTree(sourceTree())) files[`ws/${file.path}`] = file.data
    const store = new IdbWorkspaceStore()
    const result = await importBag(await readZipBag(await zipOf(files), 'ws'), { origin: 'ws' }, store)

    const entries = await store.listEntries(result.workspace)
    expect(entries.map(entry => entry.id).sort()).toEqual(['a', 'b'])
    expect(await new IdbCarrier(result.workspace).referencesOf('a')).toEqual(['b'])
    expect(result.missingPayloads).toEqual([])
  })

  // A folder that had an archive unzipped into it keeps a trashed payload under
  // the trash directory; the manifest still names it, and the reader resolves
  // that location instead of reporting it missing.
  it('resolves a trashed payload from the .oversolved-trash directory', async () => {
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n# live\n' }),
      documentEntry('t', 'T', { text: 'kind: part\n# trashed\n' }),
    ], 'source-ws')
    tree.manifest.trash = ['t']
    const files: Record<string, string | Uint8Array> = {}
    for (const file of serializeTree(tree)) files[file.path] = file.data
    const trashedPath = tree.manifest.entries.t.path
    const payload = files[trashedPath]
    delete files[trashedPath]
    files[`${TRASH_DIR}/${trashedPath}`] = payload

    const parsed = readBagTree(await readZipBag(await zipOf(files), 'ws'))

    expect(parsed.tree.manifest.trash).toContain('t')
    expect(parsed.tree.contents.get('t')?.text).toBe('kind: part\n# trashed\n')
  })

  it('refuses a bag with more than one manifest instead of picking one', async () => {
    const bytes = await zipOf({
      '.oversolved-manifest.yaml': 'format: 1\nworkspace: root\n',
      'wrapped/.oversolved-manifest.yaml': 'format: 1\nworkspace: wrapped\n',
    })
    const store = new IdbWorkspaceStore()
    await expect(importBag(await readZipBag(bytes, 'multi'), { origin: 'multi' }, store))
      .rejects.toThrow(/2 manifests/)
  })

  it('drops a sidecar png that sits beside a manifest-named document', async () => {
    const tree = sourceTree()
    const files: Record<string, string | Uint8Array> = {}
    for (const file of serializeTree(tree)) files[file.path] = file.data
    const docPath = Object.values(tree.manifest.entries).find(row => row.kind === 'document')!.path
    files[docPath.replace(/\.[^./]*$/, '.png')] = new Uint8Array([0x89, 0x50])

    const parsed = readBagTree(await readZipBag(await zipOf(files), 'ws'))
    expect(parsed.skippedReserved).toBe(1)
    expect(Object.values(parsed.tree.manifest.entries).some(row => row.name.endsWith('.png'))).toBe(false)
  })

  it('reports no references for a manifest-named document whose text does not parse', async () => {
    const parsed = readBagTree(await readZipBag(
      await buildZipBytes(treeWith([documentEntry('a', 'A', { text: ': : not a mapping\n' })], 'source-ws')),
      'ws',
    ))
    expect(parsed.tree.manifest.entries.a).toBeDefined()
    expect(parsed.unattached).toEqual([])
  })
})

// A YAML export writes the document verbatim and the payload never carried its
// kind (the manifest did), so every exported `.yaml` reaches the classifier
// kind-less and used to land as an unopenable file entry. Until the export
// stamps it, the manifest-less branch guesses from the shape.
describe('adoption: a kind-less document payload', () => {
  beforeEach(resetWorkspaceIdb)

  const EXPORTED_PART = [
    'features:',
    '  - id: Origin',
    '    kind: origin',
    '  - id: n5fZFV21',
    '    kind: extrude',
    '    extrude:',
    '      distance: 21',
    'part_style:',
    '  body_n5fZFV21:',
    '    name: part 1',
    '',
  ].join('\n')

  it('adopts an exported part yaml as a document, not a file', async () => {
    const store = new IdbWorkspaceStore()
    const result = await importBag(bag('ring.yaml', EXPORTED_PART), { origin: 'drop' }, store)

    expect(result.documents).toBe(1)
    expect(result.files).toBe(0)
    const [entry] = await store.listEntries(result.workspace)
    expect(entry).toMatchObject({ kind: 'document', name: 'ring', docKind: 'part' })
  })

  it('adopts a kind-less assembly payload as an assembly', () => {
    const text = ASSEMBLY.replace('kind: assembly\n', '')
    const parsed = readBagTree(bag('Gearbox.yml', text))
    expect(Object.values(parsed.tree.manifest.entries)[0]).toMatchObject({
      kind: 'document', docKind: 'assembly',
    })
  })

  it('guesses only for a yaml extension, so other payloads stay files', () => {
    const parsed = readBagTree(bag('notes.txt', EXPORTED_PART))
    expect(Object.values(parsed.tree.manifest.entries)[0]).toMatchObject({ kind: 'file' })
  })

  it('leaves a stamped but unsupported kind a file rather than guessing past it', () => {
    const parsed = readBagTree(bag('sheet.yaml', `kind: drawing\n${EXPORTED_PART}`))
    expect(Object.values(parsed.tree.manifest.entries)[0]).toMatchObject({ kind: 'file' })
  })

  it('pairs a png sidecar with the document it pictures', () => {
    const parsed = readBagTree({
      origin: 'legacy',
      items: [
        { path: 'ring.yaml', bytes: new TextEncoder().encode(EXPORTED_PART) },
        { path: 'ring.png', bytes: new Uint8Array([1, 2, 3]) },
      ],
    })
    expect(parsed.skippedReserved).toBe(1)
    expect(parsed.previews.size).toBe(1)
  })
})
