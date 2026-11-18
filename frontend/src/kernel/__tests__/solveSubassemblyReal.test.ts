/**
 * A sub-assembly as the parent sees it, against the real mate solver: the child
 * solves inside its own document, flattens into one rigid composite, and the
 * parent mate moves the whole composite without reaching into it.
 *
 * The recursive main-thread walk itself is covered by useAssemblySolve's tests;
 * this file pins the kernel half those tests hand a fake payload for: a real
 * child solve, a real composite, and a real parent solve over its path-prefixed
 * anchors.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly, type MateSpec } from '../solveAssembly'
import { identity } from '@/__tests__/fixtures'
import { bundleCachePut, resetBundleDbConnection } from '../bundleCache'
import { loadPkgNodeExport, PKG_MATE } from '../../wasm-kernel/loadPkgNode'
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'
import { buildAssemblyBundle } from '../assemblyBundle'
import { composeTransforms, invertTransform, type Transform3D } from '../../utils/transform3d'
import type { PartInstance } from '../../types/cad'
import type { RelayService } from '../worker/solverProtocol'

const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = solveMate ? describe : describe.skip

function at(tx: number, ty: number, tz: number): Transform3D {
  return { tx, ty, tz, qx: 0, qy: 0, qz: 0, qw: 1 }
}

function planeBundle(docId: string, hash: string): PartBundle {
  return {
    doc_id: docId,
    content_hash: hash,
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
    anchors: {
      face: {
        kind: 'plane',
        point: [0, 0, 0],
        axis: [0, 0, 1],
        geom_hash: `@gdf|${docId}`,
        created_by: 'box',
      },
    },
  }
}

const relay: RelayService = {
  requestPartDoc: async () => ({ kind: 'part', features: [] }),
  requestBuildBundle: async () => { throw new Error('should not build: bundles are pre-cached') },
}

const hashes = { 'doc-c1': '1', 'doc-c2': '1', 'doc-pa': '1' }

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
  await bundleCachePut(planeBundle('doc-c1', '1'))
  await bundleCachePut(planeBundle('doc-c2', '1'))
  await bundleCachePut(planeBundle('doc-pa', '1'))
})

function childInstances(): PartInstance[] {
  return [
    { handle: 'c1', doc_id: 'doc-c1', doc_rev: 0, transform: identity() },
    { handle: 'c2', doc_id: 'doc-c2', doc_rev: 0, transform: at(0, 0, 20) },
  ]
}

function childMates(offset: number): MateSpec[] {
  return [{
    id: 'child-m1',
    kind: 'fixed',
    offset,
    ref_a: { part: 'c1', anchor: 'face' },
    ref_b: { part: 'c2', anchor: 'face' },
  }]
}

/** Solve the child document and flatten it exactly as the main-thread walk does. */
async function solveChild(offset: number) {
  const parts = childInstances().map(inst => ({
    handle: inst.handle, doc_id: inst.doc_id, transform: inst.transform,
  }))
  const child = await solveAssembly(parts, hashes, childMates(offset), relay, solveMate!)
  const bundle = buildAssemblyBundle('child-hash', childInstances(), {
    transforms: child.transforms,
    bodies: child.bodies,
    anchors: child.anchors,
    anchorDescriptors: child.anchorDescriptors,
    leaves: child.leaves,
    status: child.status,
  })
  return { child, bundle }
}

describeReal('a sub-assembly in the parent solve', () => {
  it('enters rigidly and the parent mate moves the whole child', async () => {
    const { child, bundle } = await solveChild(10)
    // The child's own mate holds the two leaves 10 mm apart in its frame.
    expect(child.transforms.c2.tz - child.transforms.c1.tz).toBeCloseTo(10, 3)

    const parts = [
      { handle: 'pa', doc_id: 'doc-pa', transform: identity(), fixed: true },
      { handle: 'sub', doc_id: 'doc-child', transform: at(50, 5, 5), bundle },
    ]
    const mates: MateSpec[] = [{
      id: 'parent-m1',
      kind: 'fixed',
      ref_a: { part: 'pa', anchor: 'face' },
      // The parent reaches into the child by the path-prefixed anchor id.
      ref_b: { part: 'sub', anchor: 'c2/face' },
    }]

    const parent = await solveAssembly(parts, hashes, mates, relay, solveMate!)

    expect(parent.status.mates['parent-m1'].stale).toBe(false)
    expect(parent.status.mates['parent-m1'].error).toBeUndefined()
    expect(parent.status.parts['sub']?.failed).not.toBe(true)
    // The child's c2 face sits at c2's child pose; the parent mate puts it on
    // the parent's face at the world origin, so the whole composite translates
    // by the negative of that pose.
    const sub = parent.transforms['sub']
    expect(sub.tx).toBeCloseTo(0, 2)
    expect(sub.ty).toBeCloseTo(0, 2)
    expect(sub.tz).toBeCloseTo(-child.transforms.c2.tz, 2)
    // Two leaves under one handle, still the child's own relative pose.
    const leaves = parent.leaves['sub']
    expect(leaves.map(leaf => leaf.doc_id).sort()).toEqual(['doc-c1', 'doc-c2'])
    const c1 = leaves.find(leaf => leaf.doc_id === 'doc-c1')!
    const c2 = leaves.find(leaf => leaf.doc_id === 'doc-c2')!
    expect(c2.transform.tz - c1.transform.tz).toBeCloseTo(10, 3)
    // The composite renders both bodies under the one instance handle.
    expect(parent.bodies['sub']).toHaveLength(2)
  })

  it('re-solving the child with a new mate offset moves the leaf in the parent', async () => {
    const first = await solveChild(10)
    const firstParts = [
      { handle: 'pa', doc_id: 'doc-pa', transform: identity(), fixed: true },
      { handle: 'sub', doc_id: 'doc-child', transform: identity(), bundle: first.bundle },
    ]
    const noParentMate: MateSpec[] = []
    const firstParent = await solveAssembly(firstParts, hashes, noParentMate, relay, solveMate!)
    const firstLeaves = firstParent.leaves['sub']
    const firstC2 = firstLeaves.find(leaf => leaf.doc_id === 'doc-c2')!

    const second = await solveChild(25)
    const secondParts = [
      { handle: 'pa', doc_id: 'doc-pa', transform: identity(), fixed: true },
      { handle: 'sub', doc_id: 'doc-child', transform: identity(), bundle: second.bundle },
    ]
    const secondParent = await solveAssembly(secondParts, hashes, noParentMate, relay, solveMate!)
    const secondC2 = secondParent.leaves['sub'].find(leaf => leaf.doc_id === 'doc-c2')!

    // The leaf follows the child's own re-solve: the new offset moves c2 inside
    // the child, and the flattened leaf carries exactly that movement.
    expect(secondC2.transform.tz - firstC2.transform.tz).toBeCloseTo(
      second.child.transforms.c2.tz - first.child.transforms.c2.tz,
      3,
    )
  })

  it('keeps the child rigid when the parent mate is at an angle', async () => {
    const { bundle } = await solveChild(10)
    const parts = [
      { handle: 'pa', doc_id: 'doc-pa', transform: identity(), fixed: true },
      { handle: 'sub', doc_id: 'doc-child', transform: at(40, 0, 0), bundle },
    ]
    const mates: MateSpec[] = [{
      id: 'parent-m1',
      kind: 'fixed',
      angle: 30,
      ref_a: { part: 'pa', anchor: 'face' },
      ref_b: { part: 'sub', anchor: 'c1/face' },
    }]

    const parent = await solveAssembly(parts, hashes, mates, relay, solveMate!)
    expect(parent.status.mates['parent-m1'].error).toBeUndefined()

    const leaves = parent.leaves['sub']
    const c1 = leaves.find(leaf => leaf.doc_id === 'doc-c1')!
    const c2 = leaves.find(leaf => leaf.doc_id === 'doc-c2')!
    // The parent's rotation applies to the child as a whole: the relative pose
    // is unchanged (compose the inverse of c2's pose onto c1 and compare with
    // the child's own frame).
    const relative = composeTransforms(invertTransform(c2.transform), c1.transform)
    expect(Math.hypot(relative.tx, relative.ty, relative.tz)).toBeCloseTo(10, 3)
  })
})
