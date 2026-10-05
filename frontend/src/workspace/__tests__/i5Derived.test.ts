import { describe, it, expect, beforeEach } from 'vitest'
import { IdbWorkspaceStore } from '../store'
import { deserializeTree } from '../serializer'
import { getPreviewStore } from '@/stores/previewStore'
import { bundleCacheHas, resetBundleDbConnection } from '@/kernel/bundleCache'
import { solveAssembly } from '@/kernel/solveAssembly'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'
import type { RelayService } from '@/kernel/worker/solverProtocol'
import { resetWorkspaceIdb } from './idbHarness'

// The exact shape a cold solve caches: a part bundle in its own database,
// outside the workspace tree. The solve path below runs the real orchestration
// (bundle build via the relay -> cache put) with a fake relay, so I5 is proven
// against the artifact the solve actually deposits, not a stand-in.
function solvedBundle(docId: string, rev: string): PartBundle {
  return {
    doc_id: docId,
    content_hash: rev,
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

function relay(): RelayService {
  return {
    requestPartDoc: async () => ({ kind: 'part', features: [] }),
    requestBuildBundle: async (docId, rev) => solvedBundle(docId, rev),
  }
}

describe('I5: derived artifacts stay out of the workspace tree', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    resetBundleDbConnection()
  })

  it('a full solve and a preview render never land in the exported bag', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Bracket', { docKind: 'part' })
    const image = btoa('\x89PNG\r\n')
    await getPreviewStore().put(workspace, workspace, image)

    // The solve: a cold bundle build lands in the bundle cache, a derived
    // artifact outside the workspace database. No mates, so the solve echoes the
    // placement but still runs the bundle fetch/build/cache path.
    await solveAssembly(
      [{ handle: 'p1', doc_id: 'part-1', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { 'part-1': '1' },
      [],
      relay(),
      null,
    )
    expect(await bundleCacheHas('part-1', '1')).toBe(true)

    const exported = await store.export(workspace)
    for (const file of exported) {
      // No bundle, mesh, cache or preview path may be an entry in the bag.
      expect(file.path).not.toMatch(/preview|bundle|mesh|cache/i)
    }
    expect(exported.some(file => file.path === '.oversolved-manifest.yaml')).toBe(true)

    const tree = deserializeTree(exported)
    expect(Object.values(tree.manifest.entries)).toHaveLength(1)

    // The preview lives in its own store, readable outside the bag; the solved
    // bundle lives in the bundle cache, also outside it.
    expect(await getPreviewStore().get(workspace, workspace)).toBe(image)
  })
})
