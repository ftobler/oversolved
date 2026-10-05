import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorkspaceTree } from '../types'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier, readWorkspaceMeta } from '../idbCarrier'
import { importBag, originState, readZipBag, updateFromOrigin } from '../import'
import { buildZipBytes } from '../zipCarrier'
import { hashRecord, partBundleKey } from '../contentHash'
import type { OriginResolver } from '../originResolver'
import { addReference } from '../refs'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'
import { bundleCachePut, resetBundleDbConnection } from '@/kernel/bundleCache'
import { solveAssembly } from '@/kernel/solveAssembly'
import type { RelayService } from '@/kernel/worker/solverProtocol'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import * as originResolver from '../originResolver'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// C6's update half. An origin is only ever read by the explicit gesture, so
// these pass the resolver in rather than touching a handle. The update is a
// snapshot-inward pull over the clicked root's transitive closure: the copy is
// overwritten, everything outside the closure is left byte-identical.

function warmBundle(docId: string, contentHash: string): PartBundle {
  return {
    doc_id: docId,
    content_hash: contentHash,
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: {
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        faceIdsPerTriangle: new Uint32Array([0]),
      },
      edges: [],
      entityAnchors: { faces: [], edges: [], vertices: [] },
    }],
    anchors: {},
  }
}

function resolverReturning(tree: WorkspaceTree | null): OriginResolver {
  return { register: vi.fn(), resolve: async () => tree }
}

async function importSource(
  store: IdbWorkspaceStore, source: WorkspaceTree, locator = 'zip:src',
): Promise<{ workspace: string; entry: string }> {
  const bag = await readZipBag(await buildZipBytes(source), locator)
  const result = await importBag(bag, { origin: { locator, workspace: source.manifest.workspace } }, store)
  const meta = await readWorkspaceMeta(result.workspace)
  return { workspace: result.workspace, entry: meta!.provenance[0].entry }
}

async function localHash(store: IdbWorkspaceStore, workspace: string, entry: string): Promise<string | undefined> {
  return (await store.listEntries(workspace)).find(meta => meta.id === entry)?.contentHash
}

describe('origin state', () => {
  beforeEach(resetWorkspaceIdb)

  it('reports current when the source hash is unchanged, changed when it moved', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    const meta = await readWorkspaceMeta(workspace)
    const record = meta!.provenance[0]

    expect((await originState(record, await localHash(store, workspace, entry), resolverReturning(v1))).status).toBe('current')

    const v2 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v2\n' })], 'src')
    expect((await originState(record, await localHash(store, workspace, entry), resolverReturning(v2))).status).toBe('changed')
  })

  it('reports unreachable when the resolver returns null and still reports editedLocally', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    const record = (await readWorkspaceMeta(workspace))!.provenance[0]

    await store.writeEntry(workspace, { ...(await store.readEntry(workspace, entry)), text: 'kind: part\n# local\n' })
    const state = await originState(record, await localHash(store, workspace, entry), resolverReturning(null))
    expect(state.status).toBe('unreachable')
    expect(state.editedLocally).toBe(true)
  })

  it('reports changed when the resolved source no longer holds the entry', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    const record = (await readWorkspaceMeta(workspace))!.provenance[0]

    // The source opened but no longer carries the recorded entry: that is a
    // status, not an unreachable origin and not a delete.
    const state = await originState(record, await localHash(store, workspace, entry), resolverReturning(treeWith([], 'src')))
    expect(state.status).toBe('changed')
  })

  it('reports not-updatable without reading the origin when the record has no source entry id', async () => {
    const resolve = vi.fn(async () => null)
    const resolver: OriginResolver = { register: vi.fn(), resolve }
    const state = await originState({ entry: 'e', origin: 'file:loose' }, undefined, resolver)
    expect(state.status).toBe('not-updatable')
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('updateFromOrigin', () => {
  beforeEach(resetWorkspaceIdb)

  it('reports sourceMissing without reading the origin when the local entry has no provenance', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Local', { docKind: 'part' })
    const resolve = vi.fn(async () => null)
    const resolver: OriginResolver = { register: vi.fn(), resolve }

    const result = await updateFromOrigin(workspace, workspace, resolver, store)
    expect(result).toMatchObject({ updated: 0, added: 0, sourceMissing: true, unreachable: false })
    // Nothing to correlate on, so the origin read is skipped rather than wasted.
    expect(resolve).not.toHaveBeenCalled()
  })

  it('overwrites the copy and re-stamps the source hash and copiedAt', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    const v2 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v2\n' })], 'src')

    const result = await updateFromOrigin(workspace, entry, resolverReturning(v2), store)
    expect(result).toMatchObject({ updated: 1, added: 0, unreachable: false, sourceMissing: false })
    expect((await store.readEntry(workspace, entry)).text).toBe('kind: part\n# v2\n')
    const record = (await readWorkspaceMeta(workspace))!.provenance[0]
    expect(record.hash).toBe(hashRecord({ kind: 'document', text: 'kind: part\n# v2\n' }))
  })

  it('a locally edited copy is overwritten by the pull', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    await store.writeEntry(workspace, { ...(await store.readEntry(workspace, entry)), text: 'kind: part\n# local\n' })

    await updateFromOrigin(workspace, entry, resolverReturning(v1), store)
    expect((await store.readEntry(workspace, entry)).text).toBe('kind: part\n# v1\n')
  })

  it('leaves an unrelated edited entry byte-identical and rev-unchanged', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    await store.addEntry(workspace, {
      id: 'keep', kind: 'document', name: 'Keep', docKind: 'part', text: 'kind: part\n# keep\n',
    })
    const before = (await store.listEntries(workspace)).find(meta => meta.id === 'keep')!

    const v2 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v2\n' })], 'src')
    await updateFromOrigin(workspace, entry, resolverReturning(v2), store)

    const after = (await store.listEntries(workspace)).find(meta => meta.id === 'keep')!
    expect((await store.readEntry(workspace, 'keep')).text).toBe('kind: part\n# keep\n')
    expect(after.rev).toBe(before.rev)
    expect(after.contentHash).toBe(before.contentHash)
  })

  it('writes nothing when the origin is unreachable', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    await store.writeEntry(workspace, { ...(await store.readEntry(workspace, entry)), text: 'kind: part\n# local\n' })
    const before = (await store.listEntries(workspace)).find(meta => meta.id === entry)!

    const result = await updateFromOrigin(workspace, entry, resolverReturning(null), store)
    expect(result.unreachable).toBe(true)
    expect((await store.readEntry(workspace, entry)).text).toBe('kind: part\n# local\n')
    const after = (await store.listEntries(workspace)).find(meta => meta.id === entry)!
    expect(after.rev).toBe(before.rev)
  })

  it('does not rewrite the carrier when the source is unchanged', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    const beforeMeta = (await readWorkspaceMeta(workspace))!.provenance[0]
    const beforeRev = (await store.listEntries(workspace)).find(meta => meta.id === entry)!.rev
    const save = vi.spyOn(store, 'save')

    const result = await updateFromOrigin(workspace, entry, resolverReturning(v1), store)

    expect(result).toMatchObject({ updated: 0, added: 0, unreachable: false, sourceMissing: false })
    expect(save).not.toHaveBeenCalled()
    const afterMeta = (await readWorkspaceMeta(workspace))!.provenance[0]
    expect(afterMeta.copiedAt).toBe(beforeMeta.copiedAt)
    expect((await store.listEntries(workspace)).find(meta => meta.id === entry)!.rev).toBe(beforeRev)
    save.mockRestore()
  })

  it('adds an entry the source closure now references that the copy never had', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([
      documentEntry('asm', 'Asm', { text: 'kind: assembly\n# v1\n' }),
      documentEntry('part', 'Part', { text: 'kind: part\n# v1\n' }),
    ], 'src')
    addReference(v1, 'asm', 'part')
    const { workspace } = await importSource(store, v1)

    const v2 = treeWith([
      documentEntry('asm', 'Asm', { text: 'kind: assembly\n# v2\n' }),
      documentEntry('part', 'Part', { text: 'kind: part\n# v1\n' }),
      documentEntry('part2', 'Part2', { text: 'kind: part\n# new\n' }),
    ], 'src')
    addReference(v2, 'asm', 'part')
    addReference(v2, 'asm', 'part2')

    const result = await updateFromOrigin(workspace, 'asm', resolverReturning(v2), store)
    expect(result).toMatchObject({ updated: 1, added: 1 })
    // The never-seen entry is minted a fresh local id, so it is found by what it
    // holds, not by an id the source happened to use.
    const entries = await store.listEntries(workspace)
    expect(entries).toHaveLength(3)
    const added = await Promise.all(entries.map(meta => store.readEntry(workspace, meta.id)))
    expect(added.map(entry => entry.text)).toContain('kind: part\n# new\n')
  })

  it('reports sourceMissing and leaves the copy alone when the source no longer holds the entry', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    const before = (await store.listEntries(workspace)).find(meta => meta.id === entry)!

    const emptied = treeWith([], 'src')
    const result = await updateFromOrigin(workspace, entry, resolverReturning(emptied), store)

    // A missing source entry is a status, never a delete: the local copy stays.
    expect(result).toMatchObject({ updated: 0, added: 0, sourceMissing: true, unreachable: false })
    expect((await store.readEntry(workspace, entry)).text).toBe('kind: part\n# v1\n')
    expect((await store.listEntries(workspace)).find(meta => meta.id === entry)!.rev).toBe(before.rev)
  })

  it('picks up a local edit made while the source was resolving', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v1\n' })], 'src')
    const { workspace, entry } = await importSource(store, v1)
    const v2 = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# v2\n' })], 'src')
    let raced = false
    const racing: OriginResolver = {
      register: vi.fn(),
      resolve: async () => {
        if (!raced) {
          raced = true
          await store.addEntry(workspace, {
            id: 'keep', kind: 'document', name: 'Keep', docKind: 'part', text: 'kind: part\n# keep\n',
          })
        }
        return v2
      },
    }

    await updateFromOrigin(workspace, entry, racing, store)

    // The tree the update writes is opened after the resolve, so the entry that
    // landed mid-resolve survives the whole-snapshot save.
    expect((await store.readEntry(workspace, 'keep')).text).toBe('kind: part\n# keep\n')
    expect((await store.readEntry(workspace, entry)).text).toBe('kind: part\n# v2\n')
  })

  it('updates only the clicked copy when one source was imported twice', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([
      documentEntry('part', 'Part', { text: 'kind: part\n# v1\n' }),
      documentEntry('asm', 'Asm', { text: 'kind: assembly\n# v1\n' }),
    ], 'src')
    addReference(v1, 'asm', 'part')
    const first = await importBag(
      await readZipBag(await buildZipBytes(v1), 'zip:a'),
      { origin: { locator: 'zip:a', workspace: 'src', name: 'src' } },
      store,
    )
    await importBag(
      await readZipBag(await buildZipBytes(v1), 'zip:a'),
      { into: first.workspace, origin: { locator: 'zip:a', workspace: 'src', name: 'src' } },
      store,
    )

    const meta = (await readWorkspaceMeta(first.workspace))!
    const roots = meta.provenance.filter(record => record.originEntry === 'asm')
    expect(roots).toHaveLength(2)
    const copyA = roots[0]
    const copyB = roots[1]
    expect(copyA.originGroup).toBeDefined()
    expect(copyA.originGroup).not.toBe(copyB.originGroup)
    const partOf = (group: string) =>
      meta.provenance.find(record => record.originGroup === group && record.originEntry === 'part')!.entry
    const partA = partOf(copyA.originGroup!)
    const partB = partOf(copyB.originGroup!)

    // Edit copy A's part locally so a wrong mapping would be visible.
    await store.writeEntry(first.workspace, {
      ...(await store.readEntry(first.workspace, partA)), text: 'kind: part\n# A local\n',
    })
    const revBefore = (await store.listEntries(first.workspace)).find(item => item.id === partA)!.rev

    const v2 = treeWith([
      documentEntry('part', 'Part', { text: 'kind: part\n# v2\n' }),
      documentEntry('asm', 'Asm', { text: 'kind: assembly\n# v2\n' }),
    ], 'src')
    addReference(v2, 'asm', 'part')
    const result = await updateFromOrigin(first.workspace, copyB.entry, resolverReturning(v2), store)
    expect(result).toMatchObject({ updated: 2, added: 0 })

    // Copy A is untouched; copy B is the pulled version.
    expect((await store.readEntry(first.workspace, partA)).text).toBe('kind: part\n# A local\n')
    expect((await store.listEntries(first.workspace)).find(item => item.id === partA)!.rev).toBe(revBefore)
    expect((await store.readEntry(first.workspace, partB)).text).toBe('kind: part\n# v2\n')
    expect((await store.readEntry(first.workspace, copyB.entry)).text).toBe('kind: assembly\n# v2\n')
  })

  it('pulls the transitive closure of an assembly and the copy still solves with the origin gone', async () => {
    const store = new IdbWorkspaceStore()
    const v1 = treeWith([
      documentEntry('part', 'Part', { text: 'kind: part\n# p1\n' }),
      documentEntry('asm', 'Asm', { text: 'kind: assembly\n' }),
    ], 'src')
    addReference(v1, 'asm', 'part')
    const { workspace } = await importSource(store, v1)

    const v2 = treeWith([
      documentEntry('part', 'Part', { text: 'kind: part\n# p2\n' }),
      documentEntry('asm', 'Asm', { text: 'kind: assembly\n# p2\n' }),
    ], 'src')
    addReference(v2, 'asm', 'part')

    const result = await updateFromOrigin(workspace, 'asm', resolverReturning(v2), store)
    expect(result.updated).toBe(2)
    expect((await store.readEntry(workspace, 'part')).text).toBe('kind: part\n# p2\n')
    expect(await new IdbCarrier(workspace).referencesOf('asm')).toEqual(['part'])
    // Reused through provenance, never duplicated.
    expect((await store.listEntries(workspace)).map(meta => meta.id).sort()).toEqual(['asm', 'part'])
    // The copy is self-contained: every entry still carries a source key, and
    // the resolver is never needed to read it.
    const records = (await readWorkspaceMeta(workspace))!.provenance
    expect(records.every(record => record.originEntry !== undefined)).toBe(true)

    // With the origin unreachable, the pulled part still warm-solves from the
    // working copy and the resolver spy stays at zero.
    resetBundleDbConnection()
    resetDbConnection()
    const spy = vi.spyOn(originResolver, 'resolveOrigin')
    const part = (await store.listEntries(workspace)).find(meta => meta.id === 'part')!
    const key = partBundleKey(part.contentHash!, [])
    await bundleCachePut(warmBundle('part', key))
    const relay: RelayService = {
      requestPartDoc: vi.fn(async () => { throw new Error('warm solve must not read the partition') }),
      requestBuildBundle: vi.fn(async () => { throw new Error('warm solve must not build') }),
    }
    const solved = await solveAssembly(
      [{ handle: 'p1', doc_id: 'part', transform: { ...IDENTITY_TRANSFORM } }],
      { part: key },
      [],
      relay,
      null,
    )
    expect(solved.bodies['p1']).toHaveLength(1)
    expect(relay.requestPartDoc).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
