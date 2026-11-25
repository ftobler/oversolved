// Render-mesh reuse across incremental builds (kernel/builderMeshReuse.ts), on
// fake solvers: a body's mesh is reused exactly when its provenance proves the
// geometry and naming are the previous build's, and the pick world is cached on
// its checkpoint, one non-final checkpoint at a time.

import { describe, it, expect } from 'vitest'
import { build, type FeatureResult } from '../builder'
import type { PartSolid, BuildState } from '../types3d'
import { makeDeps } from '../builderTestUtils'
import {
  renderStamp,
  unchangedSinceStamp,
  firstMeshDifference,
  MeshReuseMismatchError,
} from '../builderMeshReuse'

function part(id: string, createdBy: string, shape: number): PartSolid {
  return {
    id, created_by: createdBy, modified_by: [], shape: shape as unknown as PartSolid['shape'],
    sketch_id: '', brep_diff: null, profile_queries: [], face_uuids: ['u1', 'u2'],
  }
}

describe('unchangedSinceStamp', () => {
  it('holds for an untouched body', () => {
    const p = part('A', 'f1', 1)
    expect(unchangedSinceStamp(p, renderStamp(p))).toBe(true)
  })

  it('fails when the handle moves without a modified_by push', () => {
    const p = part('A', 'f1', 1)
    const stamp = renderStamp(p)
    p.shape = 2 as unknown as PartSolid['shape']
    expect(unchangedSinceStamp(p, stamp)).toBe(false)
  })

  it('fails when face_uuids is a new array, even with equal content', () => {
    const p = part('A', 'f1', 1)
    const stamp = renderStamp(p)
    p.face_uuids = [...p.face_uuids!]
    expect(unchangedSinceStamp(p, stamp)).toBe(false)
  })

  it('fails when modified_by grows', () => {
    const p = part('A', 'f1', 1)
    const stamp = renderStamp(p)
    p.modified_by.push('f2')
    expect(unchangedSinceStamp(p, stamp)).toBe(false)
  })

  it('compares the owner maps by content, since every feature rebuilds them', () => {
    const p = { ...part('A', 'f1', 1), face_owner: { u1: 'f2' } }
    const stamp = renderStamp(p)
    p.face_owner = { u1: 'f2' }
    expect(unchangedSinceStamp(p, stamp)).toBe(true)
    p.face_owner = { u1: 'f3' }
    expect(unchangedSinceStamp(p, stamp)).toBe(false)
  })
})

describe('firstMeshDifference', () => {
  it('names the first differing path and ignores sub-1e-9 drift', () => {
    expect(firstMeshDifference({ a: [1, 2] }, { a: [1, 2 + 1e-12] })).toBeNull()
    expect(firstMeshDifference({ a: [1, 2] }, { a: [1, 3] })).toBe('.a[1]')
    expect(firstMeshDifference({ a: [1] }, { a: [1], b: 0 })).toBe('.b')
    expect(firstMeshDifference({ v: new Float32Array([1, 2]) }, { v: [1, 2] })).toBeNull()
  })
})

// ─── Fake feature stack ───

// `create` mints a body; `modify` gives it a new handle and pushes its id unless
// `silent` (the "changed without a push" case); `noop` touches nothing, standing
// in for a modifier edited into an error or a no-op.
interface Rig {
  tessellated: string[][]
  run: (features: Array<Record<string, unknown>>, opts?: {
    prevState?: BuildState | null
    pickBoundary?: number | null
    rollbackPosition?: number | null
    verifyMeshReuse?: boolean
  }) => ReturnType<typeof build>
}

function rig(): Rig {
  let handle = 100
  const tessellated: string[][] = []
  const deps = makeDeps({
    trySolveFeature: (feature, _repo, store): FeatureResult => {
      const fid = String(feature.id)
      const target = String(feature.target ?? '')
      if (feature.kind === 'create') {
        store[target] = part(target, fid, handle++)
      } else if (feature.kind === 'modify' && store[target]) {
        store[target].shape = handle++ as unknown as PartSolid['shape']
        if (!feature.silent) store[target].modified_by.push(fid)
      }
      return { status: 'ok' }
    },
    // Keeps the in-loop identification off the render fake, so `tessellated`
    // counts render passes only.
    extractBrepMetadata: () => ({}),
    // The mesh is a pure function of the render inputs, like the real one.
    tessellateParts: (store) => {
      tessellated.push(Object.keys(store).sort())
      return Object.fromEntries(Object.entries(store).filter(([, b]) => b.shape != null).map(([bid, b]) => [
        bid, { mesh: { vertices: [[Number(b.shape), 0, 0]] }, modified_by: [...b.modified_by] },
      ]))
    },
  })
  return {
    tessellated,
    run: (features, opts = {}) => build({ features }, opts, deps),
  }
}

const twoParts = (fmParam: number) => [
  { id: 'fA', kind: 'create', target: 'A' },
  { id: 'fB', kind: 'create', target: 'B' },
  { id: 'fM', kind: 'modify', target: 'B', param: fmParam },
]

describe('final render reuse', () => {
  it('tessellates only the body the tail modified and hands the other its old mesh', () => {
    const r = rig()
    const r1 = r.run(twoParts(1))
    expect(r.tessellated).toEqual([['A', 'B']])
    r.tessellated.length = 0
    const r2 = r.run(twoParts(2), { prevState: r1._build_state })
    expect(r.tessellated).toEqual([['B']])
    expect(r2.bodies.A).toBe(r1.bodies.A)
    expect(r2.bodies.A).toBe(r1._build_state.checkpoints.fM.bodies_snapshot.A)
  })

  it('re-tessellates a body whose handle the tail replaces without pushing modified_by', () => {
    const r = rig()
    const doc = (p: number) => [
      { id: 'fA', kind: 'create', target: 'A' },
      { id: 'fB', kind: 'create', target: 'B' },
      { id: 'fM', kind: 'modify', target: 'A', silent: true, param: p },
    ]
    const r1 = r.run(doc(1))
    r.tessellated.length = 0
    const r2 = r.run(doc(2), { prevState: r1._build_state })
    // A still reads "created by fA, never modified", which the old imported-only
    // rule would have trusted.
    expect(r.tessellated).toEqual([['A']])
    expect(r2.bodies.A).not.toBe(r1.bodies.A)
    expect(r2.bodies.B).toBe(r1.bodies.B)
  })

  it('re-tessellates a body the previous tail modified and this tail no longer does', () => {
    // The previous final mesh carries fM's change, the restored body does not:
    // its history is clean, only the provenance (fM, now dirty) refuses it.
    const r = rig()
    const r1 = r.run([
      { id: 'fA', kind: 'create', target: 'A' },
      { id: 'fM', kind: 'modify', target: 'A' },
    ])
    r.tessellated.length = 0
    const r2 = r.run([
      { id: 'fA', kind: 'create', target: 'A' },
      { id: 'fM', kind: 'noop', target: 'A' },
    ], { prevState: r1._build_state, verifyMeshReuse: true })
    expect(r.tessellated).toEqual([['A']])
    expect(r2.bodies.A).not.toEqual(r1.bodies.A)
  })

  it('re-tessellates a body whose modifier is now suppressed', () => {
    const r = rig()
    const doc = (suppressed: boolean) => [
      { id: 'fA', kind: 'create', target: 'A' },
      { id: 'fM', kind: 'modify', target: 'A', suppressed },
    ]
    const r1 = r.run(doc(false))
    r.tessellated.length = 0
    const r2 = r.run(doc(true), { prevState: r1._build_state })
    expect(r.tessellated).toEqual([['A']])
    expect(r2.bodies.A).not.toEqual(r1.bodies.A)
  })

  it('keeps the carried provenance through a fully-clean rebuild into the next edit', () => {
    const r = rig()
    const r1 = r.run(twoParts(1))
    const r2 = r.run(twoParts(1), { prevState: r1._build_state })
    expect(r2._build_state.checkpoints.fM).toBe(r1._build_state.checkpoints.fM)
    r.tessellated.length = 0
    const r3 = r.run(twoParts(2), { prevState: r2._build_state })
    expect(r.tessellated).toEqual([['B']])
    expect(r3.bodies.A).toBe(r1.bodies.A)
  })

  it('keeps reusing a body across several edits of an unrelated tail feature', () => {
    const r = rig()
    let prev = r.run(twoParts(1))._build_state
    for (const p of [2, 3, 4]) {
      r.tessellated.length = 0
      prev = r.run(twoParts(p), { prevState: prev })._build_state
      expect(r.tessellated).toEqual([['B']])
    }
  })

  it('stores provenance on the final checkpoint only', () => {
    const r = rig()
    const r1 = r.run(twoParts(1))
    const marked = Object.entries(r1._build_state.checkpoints).filter(([, cp]) => cp.mesh_stable_since)
    expect(marked.map(([fid]) => fid)).toEqual(['fM'])
    expect(marked[0][1].mesh_stable_since).toEqual({ A: 'fA', B: 'fM' })
  })

  it('gives a rollback final checkpoint the mesh it renders', () => {
    const r = rig()
    const r1 = r.run(twoParts(1))
    // Rolled back to fB: every kept feature is clean, but fB never held a mesh.
    const r2 = r.run(twoParts(1), { prevState: r1._build_state, rollbackPosition: 2 })
    const cp = r2._build_state.checkpoints.fB
    expect(Object.keys(cp.bodies_snapshot).sort()).toEqual(['A', 'B'])
    expect(cp.mesh_stable_since).toBeDefined()
    // A was stable since fA in the full build, so it is reused; B's final mesh
    // was the modified one and is not.
    expect(r2.bodies.A).toBe(r1.bodies.A)
    expect(r2.bodies.B).not.toBe(r1.bodies.B)
  })

  it('the parity oracle throws, naming the body, on a corrupted cached mesh', () => {
    const r = rig()
    const r1 = r.run(twoParts(1))
    const cached = r1._build_state.checkpoints.fM.bodies_snapshot.A as { mesh: { vertices: number[][] } }
    cached.mesh.vertices[0][0] += 1
    let thrown: unknown = null
    try {
      r.run(twoParts(2), { prevState: r1._build_state, verifyMeshReuse: true })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(MeshReuseMismatchError)
    expect((thrown as MeshReuseMismatchError).partId).toBe('A')
    expect((thrown as MeshReuseMismatchError).path).toBe('.mesh.vertices[0][0]')
  })

  it('the parity oracle passes a normal edit', () => {
    const r = rig()
    const r1 = r.run(twoParts(1))
    expect(() => r.run(twoParts(2), { prevState: r1._build_state, verifyMeshReuse: true })).not.toThrow()
  })
})

// ─── Pick world ───

// fA, fB create; fM modifies B; fN modifies A. The pick world at fB holds both
// bodies unmodified, so neither can take its final mesh.
const pickDoc = (fmParam: number, faParam = 0) => [
  { id: 'fA', kind: 'create', target: 'A', param: faParam },
  { id: 'fB', kind: 'create', target: 'B' },
  { id: 'fM', kind: 'modify', target: 'B', param: fmParam },
  { id: 'fN', kind: 'modify', target: 'A' },
]

describe('pick world cache', () => {
  it('serves an open editor from the cached pick world with no tessellation', () => {
    const r = rig()
    const r1 = r.run(pickDoc(1), { pickBoundary: 2 })
    expect(r.tessellated).toEqual([['A', 'B'], ['A', 'B']])
    expect(r1._build_state.checkpoints.fB.bodies_snapshot).toBe(r1.pick_bodies)

    // A value change in the open editor (fM): fB is clean and carries the cache.
    r.tessellated.length = 0
    const r2 = r.run(pickDoc(2), { prevState: r1._build_state, pickBoundary: 2 })
    expect(r2.pick_bodies).toBe(r1.pick_bodies)
    // Only the final render (fM and fN re-ran on both bodies), no pick pass.
    expect(r.tessellated).toEqual([['A', 'B']])
    // And the served cache is exact.
    expect(() => r.run(pickDoc(3), { prevState: r2._build_state, pickBoundary: 2, verifyMeshReuse: true }))
      .not.toThrow()
  })

  it('moving the boundary meshes the new pick world once and drops the old one', () => {
    const r = rig()
    const r1 = r.run(pickDoc(1), { pickBoundary: 2 })
    r.tessellated.length = 0
    const r2 = r.run(pickDoc(1), { prevState: r1._build_state, pickBoundary: 1 })
    // Fully clean: the final mesh is reused whole, the pick world at fA is new.
    expect(r.tessellated).toEqual([['A']])
    expect(r2._build_state.checkpoints.fA.bodies_snapshot).toBe(r2.pick_bodies)
    expect(r2._build_state.checkpoints.fB.bodies_snapshot).toEqual({})
    // The carried checkpoint was copied, never edited.
    expect(r1._build_state.checkpoints.fB.bodies_snapshot).toBe(r1.pick_bodies)
  })

  it('takes the final mesh for a pick body unchanged since the boundary', () => {
    const r = rig()
    // Pick at fM (boundary 3): B is final-stable since fM, A is not (fN).
    const r1 = r.run(pickDoc(1), { pickBoundary: 3 })
    const pick = r1.pick_bodies as Record<string, unknown>
    expect(pick.B).toBe(r1.bodies.B)
    expect(pick.A).not.toBe(r1.bodies.A)
    expect(r.tessellated).toEqual([['A', 'B'], ['A']])
  })

  it('re-meshes and re-caches when a feature upstream of the boundary is edited', () => {
    const r = rig()
    const r1 = r.run(pickDoc(1), { pickBoundary: 2 })
    r.tessellated.length = 0
    const r2 = r.run(pickDoc(1, 5), { prevState: r1._build_state, pickBoundary: 2, verifyMeshReuse: true })
    expect(r2.pick_bodies).not.toBe(r1.pick_bodies)
    expect(r2._build_state.checkpoints.fB.bodies_snapshot).toBe(r2.pick_bodies)
    expect(r.tessellated).toEqual([['A', 'B'], ['A', 'B']])
  })

  it('closing the editor drops the pick world, keeping the final mesh', () => {
    const r = rig()
    const r1 = r.run(pickDoc(1), { pickBoundary: 2 })
    const r2 = r.run(pickDoc(1), { prevState: r1._build_state })
    const withMesh = Object.entries(r2._build_state.checkpoints)
      .filter(([, cp]) => Object.keys(cp.bodies_snapshot).length)
      .map(([fid]) => fid)
    expect(withMesh).toEqual(['fN'])
  })
})
