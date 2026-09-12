import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { partBundleKey } from '../contentHash'
import { resetWorkspaceIdb } from './idbHarness'
import { bundleCacheGet, bundleCachePut, resetBundleDbConnection } from '@/kernel/bundleCache'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'

function bundle(docId: string, contentHash: string): PartBundle {
  return {
    doc_id: docId,
    content_hash: contentHash,
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: {
        vertices: new Float32Array([0, 0, 0]),
        indices: new Uint32Array([]),
        faceIdsPerTriangle: new Uint32Array([]),
      },
      edges: [],
      entityAnchors: { faces: [], edges: [], vertices: [] },
    }],
    anchors: {},
  }
}

// A11: the working-copy write owns the rev, and the bundle cache keys on the
// content hash instead. A no-op write is not a change; a content write bumps rev
// once and moves the key; restoring the content restores the key and hits.
describe('rev and content-hash ownership', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    resetBundleDbConnection()
  })

  it('bumps rev once on a content write and not at all on a byte-identical write', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('P', { docKind: 'part' })
    const before = (await store.listEntries(workspace))[0]

    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'P', docKind: 'part', text: '' })
    const noop = (await store.listEntries(workspace))[0]
    expect(noop.rev).toBe(before.rev)
    expect(noop.contentHash).toBe(before.contentHash)

    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'P', docKind: 'part', text: '# edit\n' })
    const edited = (await store.listEntries(workspace))[0]
    expect(edited.rev).toBe(before.rev! + 1)
    expect(edited.contentHash).not.toBe(before.contentHash)
  })

  it('misses the old key after a write and hits again when the content is restored', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('P', { docKind: 'part' })
    const hashA = (await store.listEntries(workspace))[0].contentHash!
    const keyA = partBundleKey(hashA, [])
    await bundleCachePut(bundle(workspace, keyA))
    expect(await bundleCacheGet(workspace, keyA)).toBeDefined()

    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'P', docKind: 'part', text: '# edit\n' })
    const hashB = (await store.listEntries(workspace))[0].contentHash!
    const keyB = partBundleKey(hashB, [])
    expect(keyB).not.toBe(keyA)
    expect(await bundleCacheGet(workspace, keyB)).toBeUndefined()

    // Undo writes the A text for real: the key returns and the bundle is a hit.
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'P', docKind: 'part', text: '' })
    const hashAgain = (await store.listEntries(workspace))[0].contentHash!
    expect(partBundleKey(hashAgain, [])).toBe(keyA)
    expect(await bundleCacheGet(workspace, keyA)).toBeDefined()
  })
})
