import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { IdbCarrier } from '../idbCarrier'
import { createWorkspaceSession } from '../session'
import { resetWorkspaceIdb } from './idbHarness'
import { partBundleKey } from '../contentHash'
import { bundleCachePut, resetBundleDbConnection } from '@/kernel/bundleCache'
import { solveAssembly } from '@/kernel/solveAssembly'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'
import type { RelayService } from '@/kernel/worker/anchorSolverWorker'
import { resetDbConnection } from '@/stores/documentStore/idb'

// A warm solve must not read a part document out of the carrier. With the
// bundle cache populated at the workspace entry's own content-hash key, the
// carrier read counter stays at zero and the solver never relays a build.
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

describe('warm assembly solve', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    resetBundleDbConnection()
    resetDbConnection()
  })

  it('reads every part from the warm working copy with zero carrier reads', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })

    const session = createWorkspaceSession(workspace, store)
    const [entry] = await session.listEntries()
    expect(entry.contentHash).toBeDefined()
    const key = partBundleKey(entry.contentHash!, [])
    await bundleCachePut(warmBundle(workspace, key))

    const readSpy = vi.spyOn(IdbCarrier.prototype, 'read')
    const relay: RelayService = {
      requestPartDoc: vi.fn(async (docId: string) => {
        const part = await session.readEntry(docId)
        return { kind: 'part', text: part.text }
      }),
      requestBuildBundle: vi.fn(async () => { throw new Error('warm solve must not build') }),
    }

    const result = await solveAssembly(
      [{ handle: 'p1', doc_id: workspace, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { [workspace]: key },
      [],
      relay,
      null,
    )

    expect(result.bodies['p1']).toHaveLength(1)
    expect(relay.requestPartDoc).not.toHaveBeenCalled()
    expect(relay.requestBuildBundle).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
    readSpy.mockRestore()
  })
})
