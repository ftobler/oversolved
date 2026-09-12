import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { createWorkspaceSession } from '../session'
import { importBag, originState, readZipBag } from '../import'
import { buildZipBytes } from '../zipCarrier'
import { partBundleKey } from '../contentHash'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'
import { bundleCachePut, resetBundleDbConnection } from '@/kernel/bundleCache'
import { solveAssembly } from '@/kernel/solveAssembly'
import type { RelayService } from '@/kernel/worker/anchorSolverWorker'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import * as originResolver from '../originResolver'
import { documentEntry, treeWith } from './fixtures'
import { resetWorkspaceIdb } from './idbHarness'

// I1/I2: a workspace whose every origin is unreachable opens, lists and solves
// exactly like one with no origins, and the provenance resolver is called zero
// times outside the explicit check gesture. The stored record is read for the
// panel, never resolved.

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

describe('I1/I2: no loader or solver follows a provenance link', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    resetBundleDbConnection()
    resetDbConnection()
  })

  it('opens, lists and solves with a zero resolver count, then counts only the gesture', async () => {
    const store = new IdbWorkspaceStore()
    const source = treeWith([documentEntry('a', 'A', { text: 'kind: part\n# body\n' })], 'src')
    const bytes = await buildZipBytes(source)
    const result = await importBag(
      await readZipBag(bytes, 'folder:gone'),
      { origin: { locator: 'folder:gone' } },
      store,
    )

    const spy = vi.spyOn(originResolver, 'resolveOrigin')
    const session = createWorkspaceSession(result.workspace, store)

    // Open, list and solve: no resolver read anywhere on the path.
    await store.open(result.workspace)
    const [entry] = await session.listEntries()
    const record = await session.originOf(entry.id)
    expect(record?.origin).toBe('folder:gone')
    const key = partBundleKey(entry.contentHash!, [])
    await bundleCachePut(warmBundle(entry.id, key))
    const relay: RelayService = {
      requestPartDoc: vi.fn(async () => { throw new Error('warm solve must not read the partition') }),
      requestBuildBundle: vi.fn(async () => { throw new Error('warm solve must not build') }),
    }
    const solved = await solveAssembly(
      [{ handle: 'p1', doc_id: entry.id, transform: { ...IDENTITY_TRANSFORM } }],
      { [entry.id]: key },
      [],
      relay,
      null,
    )
    expect(solved.bodies['p1']).toHaveLength(1)
    expect(spy).not.toHaveBeenCalled()

    // The explicit check is the only thing that reads the origin. With no
    // remembered handle it resolves to null, the neutral unreachable state.
    const state = await originState(record!, entry.contentHash)
    expect(state.status).toBe('unreachable')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
