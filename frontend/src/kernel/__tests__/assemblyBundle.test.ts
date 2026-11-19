import { describe, it, expect } from 'vitest'
import type { PartInstance, Transform3D } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { buildAssemblyBundle, subassemblyWarning, type SubassemblySolvePayload } from '@/kernel/assemblyBundle'
import type { MeshPayload } from '@/kernel/solveAssembly'
import { partFrameAnchorId } from '@/kernel/partBundle'
import { assemblyBundleKey, partBundleKey } from '@/workspace/contentHash'

function instance(handle: string, docId: string, extra: Partial<PartInstance> = {}): PartInstance {
  return { handle, doc_id: docId, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, ...extra }
}

function mesh(tx: number): MeshPayload {
  return {
    vertices: new Float32Array([tx, 0, 0]),
    indices: new Uint32Array([0]),
    faceIdsPerTriangle: new Uint32Array([0]),
    edges: [],
    entityAnchors: {
      faces: [['a_face']],
      edges: [],
      vertices: [],
    },
  }
}

function posed(tx: number): Transform3D {
  return { ...IDENTITY_TRANSFORM, tx }
}

function childPayload(): SubassemblySolvePayload {
  return {
    transforms: { left: posed(10), right: posed(20) },
    bodies: { left: [mesh(10)], right: [mesh(20)] },
    anchors: {
      left: { a_left: { kind: 'plane', point: [10, 0, 0], axis: [0, 0, 1] } },
      right: { a_right: { kind: 'plane', point: [20, 0, 0], axis: [0, 0, 1] } },
    },
    anchorDescriptors: {
      left: { a_left: { geom_hash: '@u|left', kind: 'plane', created_by: 'box', point: [0, 0, 0] } },
      right: { a_right: { geom_hash: '@u|right', kind: 'plane', created_by: 'box', point: [0, 0, 0] } },
    },
    leaves: {
      left: [{ doc_id: 'p-left', transform: posed(10), visible: true }],
      right: [{ doc_id: 'p-right', transform: posed(20), visible: true }],
    },
    status: {
      verdict: 'fully_constrained', residualNorm: 0, rank: 0, dof: 0, iters: 1,
      mates: {}, parts: {},
    },
  }
}

describe('buildAssemblyBundle', () => {
  const instances = [instance('left', 'p-left'), instance('right', 'p-right')]

  it('prefixes every leaf anchor id with its child instance handle', () => {
    const bundle = buildAssemblyBundle('ch', instances, childPayload())
    expect(Object.keys(bundle.anchors).sort()).toContain('left/a_left')
    expect(Object.keys(bundle.anchors).sort()).toContain('right/a_right')
    expect(bundle.anchors['left/a_left'].point).toEqual([10, 0, 0])
    expect(bundle.anchors['right/a_right'].point).toEqual([20, 0, 0])
    // The durable identity rides through, so a parent ref can re-find it after a
    // cache wipe.
    expect(bundle.anchors['left/a_left'].geom_hash).toBe('@u|left')
  })

  it('keeps each leaf body\'s part colour inside the composite', () => {
    const payload = childPayload()
    payload.bodies.left = [{ ...mesh(10), color: '#808080' }]
    const bundle = buildAssemblyBundle('ch', instances, payload)
    expect(bundle.bodies[0].color).toBe('#808080')
    expect(bundle.bodies[1]).not.toHaveProperty('color')
  })

  it('mints the sub-assembly frame anchors like a part', () => {
    const bundle = buildAssemblyBundle('ch', instances, childPayload())
    for (const name of ['Origin', 'Front', 'Top', 'Right']) {
      const id = partFrameAnchorId(name)
      expect(id).toBeDefined()
      expect(bundle.anchors[id!]).toBeDefined()
    }
  })

  it('flattens both children into bodies and prefixes their entity anchor ids', () => {
    const bundle = buildAssemblyBundle('ch', instances, childPayload())
    expect(bundle.bodies).toHaveLength(2)
    expect(bundle.bodies[0].entityAnchors?.faces[0]).toEqual(['left/a_face'])
    expect(bundle.bodies[1].entityAnchors?.faces[0]).toEqual(['right/a_face'])
  })

  it('keeps the flatten leaves in the sub-assembly frame for export', () => {
    const bundle = buildAssemblyBundle('ch', instances, childPayload())
    expect(bundle.leaves.map(leaf => leaf.doc_id).sort()).toEqual(['p-left', 'p-right'])
    expect(bundle.leaves.find(leaf => leaf.doc_id === 'p-left')?.transform.tx).toBe(10)
  })

  it('keeps a hidden child out of the drawn bodies but not out of the anchors', () => {
    const hidden = [instance('left', 'p-left', { visible: false }), instance('right', 'p-right')]
    const bundle = buildAssemblyBundle('ch', hidden, childPayload())
    expect(bundle.bodies).toHaveLength(1)
    expect(bundle.anchors['left/a_left']).toBeDefined()
    expect(bundle.leaves.find(leaf => leaf.doc_id === 'p-left')?.visible).toBe(false)
  })

  it('carries a failed child verdict as a warning instead of dropping the body', () => {
    const payload = childPayload()
    payload.status = {
      verdict: 'overconstrained', residualNorm: 1, rank: 0, dof: 0, iters: 1,
      error: 'residual above tolerance', mates: {}, parts: {},
    }
    const bundle = buildAssemblyBundle('ch', instances, payload)
    expect(bundle.bodies).toHaveLength(2)
    expect(bundle.warning).toContain('overconstrained')
  })

  it('reports no warning for a clean child solve', () => {
    expect(subassemblyWarning(childPayload().status)).toBeUndefined()
    expect(subassemblyWarning(undefined)).toBeUndefined()
  })
})

describe('assemblyBundleKey', () => {
  it('is order independent over the child keys', () => {
    expect(assemblyBundleKey('asm', ['a', 'b'])).toBe(assemblyBundleKey('asm', ['b', 'a']))
  })

  it('changes when a leaf part key changes and not when an unrelated part does', () => {
    const first = assemblyBundleKey('asm', [partBundleKey('leaf', []), partBundleKey('other', [])])
    const leafEdited = assemblyBundleKey('asm', [partBundleKey('leaf', ['file-new']), partBundleKey('other', [])])
    // An unrelated part is not in this assembly's child list at all.
    const unrelatedEdited = assemblyBundleKey('asm', [partBundleKey('leaf', []), partBundleKey('other', [])])
    expect(leafEdited).not.toBe(first)
    expect(unrelatedEdited).toBe(first)
  })
})
