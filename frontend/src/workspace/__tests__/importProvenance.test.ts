import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WorkspaceTree } from '../types'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier, readWorkspaceMeta } from '../idbCarrier'
import { createWorkspaceSession } from '../session'
import { importBag, readZipBag } from '../import'
import { buildZipBytes } from '../zipCarrier'
import { hashRecord, partBundleKey } from '../contentHash'
import { addReference } from '../refs'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'
import { bundleCachePut, resetBundleDbConnection } from '@/kernel/bundleCache'
import { solveAssembly } from '@/kernel/solveAssembly'
import type { RelayService } from '@/kernel/worker/anchorSolverWorker'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import * as originResolver from '../originResolver'
import { bytesOf, documentEntry, fileEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// C6's import half: every landed entry carries a provenance record keyed on the
// source entry id, a transitive assembly brings the parts it references, and the
// resulting copy is self-contained -- it opens and solves with the origin
// resolver never called.

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

async function importTree(
  store: IdbWorkspaceStore, source: WorkspaceTree, locator = 'zip:src',
): Promise<string> {
  const bag = await readZipBag(await buildZipBytes(source), locator)
  const result = await importBag(bag, { origin: { locator, workspace: source.manifest.workspace } }, store)
  return result.workspace
}

describe('import provenance', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    resetBundleDbConnection()
    resetDbConnection()
  })

  it('stamps every landed entry with originEntry, hash and copiedAt', async () => {
    const store = new IdbWorkspaceStore()
    const text = 'kind: part\n# body\n'
    const source = treeWith([documentEntry('a', 'A', { text })], 'src')
    const workspace = await importTree(store, source)

    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.provenance).toHaveLength(1)
    expect(meta?.provenance[0]).toMatchObject({
      entry: 'a',
      origin: 'zip:src',
      originEntry: 'a',
      originWorkspace: 'src',
    })
    expect(meta?.provenance[0].hash).toBe(hashRecord({ kind: 'document', text }))
    expect(typeof meta?.provenance[0].copiedAt).toBe('number')
  })

  it('importing an assembly brings its referenced parts under the source ids', async () => {
    const store = new IdbWorkspaceStore()
    const source = treeWith([
      documentEntry('part', 'Part', { text: 'kind: part\n' }),
      fileEntry('step', 'part.step', bytesOf([1, 2, 3]), 'application/step'),
      documentEntry('asm', 'Asm', { text: 'kind: assembly\n' }),
    ], 'src')
    addReference(source, 'asm', 'part')
    addReference(source, 'part', 'step')
    const workspace = await importTree(store, source)

    const entries = await store.listEntries(workspace)
    expect(entries.map(entry => entry.id).sort()).toEqual(['asm', 'part', 'step'])
    const carrier = new IdbCarrier(workspace)
    expect(await carrier.referencesOf('asm')).toEqual(['part'])
    expect(await carrier.referencesOf('part')).toEqual(['step'])
    const meta = await readWorkspaceMeta(workspace)
    expect(meta?.provenance).toHaveLength(3)
    expect(meta?.provenance.find(record => record.entry === 'asm')?.originEntry).toBe('asm')
  })

  it('the copy opens, lists and warm-solves with the resolver never called', async () => {
    const store = new IdbWorkspaceStore()
    const source = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# body\n' })], 'src')
    const workspace = await importTree(store, source)

    const spy = vi.spyOn(originResolver, 'resolveOrigin')
    const session = createWorkspaceSession(workspace, store)
    await store.open(workspace)
    const [entry] = await session.listEntries()
    const key = partBundleKey(entry.contentHash!, [])
    await bundleCachePut(warmBundle(entry.id, key))

    const relay: RelayService = {
      requestPartDoc: vi.fn(async () => { throw new Error('warm solve must not read the partition') }),
      requestBuildBundle: vi.fn(async () => { throw new Error('warm solve must not build') }),
    }
    const result = await solveAssembly(
      [{ handle: 'p1', doc_id: entry.id, transform: { ...IDENTITY_TRANSFORM } }],
      { [entry.id]: key },
      [],
      relay,
      null,
    )

    expect(result.bodies['p1']).toHaveLength(1)
    expect(relay.requestPartDoc).not.toHaveBeenCalled()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
