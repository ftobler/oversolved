// The settled pose is a store concept, not a composition every caller re-derives.
// These tests pin the accessor and the freeze-then-mutate window it closes: a
// structural edit landing between a drag commit and its re-solve must bake the
// dragged pose, never the raw pre-drag transform the bodies are still baked at.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { findInstance } from '@/utils/assemblyMutations'
import { settledTransforms } from '@/utils/partManipulation'
import { offsetPickBodies, type AssemblyPickBody } from '@/utils/assemblyPick'
import { composeTransforms, IDENTITY_TRANSFORM } from '@/utils/transform3d'

function instance(handle: string, extra: Partial<PartInstance> = {}): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, ...extra }
}

function pickBody(handle: string): AssemblyPickBody {
  return {
    handle,
    bodyKey: `${handle}:body_0`,
    faces: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: [`${handle}:body_0:face0`],
    },
    edges: null,
    vertices: null,
    faceBoundaries: null,
  }
}

function docWith(...instances: PartInstance[]): AssemblyDoc {
  return {
    kind: 'assembly',
    features: instances.map((inst, i) => ({ id: `f${i}`, kind: 'part_instance' as const, instance: inst })),
  }
}

/** Stands in for the AssemblyEditor: owns the doc, counts re-solves. */
function mountHost(initial: AssemblyDoc) {
  const requestSolve = vi.fn()
  const host = { doc: initial }
  setAssemblyCallbacks({
    mutateDoc: (_label, fn) => { host.doc = fn(host.doc) },
    mutateDocSession: (_label, fn) => { host.doc = fn(host.doc) },
    requestSolve,
  })
  useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial })
  return { host, requestSolve }
}

describe('assembly pose ownership', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    useAssemblyStore.setState({ settlingOffsets: {}, pickGeometryPose: {} })
    setAssemblyCallbacks(null)
  })

  // T1: the accessor, not the caller, composes. A caller that reads `transforms`
  // gets the pose the bodies are baked at, which is a solve behind the doc.
  it('settledPose composes the owed offset exactly once', () => {
    const base = { ...IDENTITY_TRANSFORM, tx: 10 }
    const offset = { ...IDENTITY_TRANSFORM, tx: 3 }
    useAssemblyStore.setState({ transforms: { p1: base }, settlingOffsets: { p1: offset } })
    const s = useAssemblyStore.getState()

    expect(s.settledPose('p1')!.tx).toBe(13)
    expect(s.settledPose('p1')).toEqual(composeTransforms(offset, base))
    expect(s.settledPose('ghost')).toBeUndefined()
    expect(s.settledPoses()).toEqual(settledTransforms({ p1: base }, { p1: offset }))
  })

  // T2: a delete between pointer-up and the settling solve must bake the dragged
  // pose. deleteSelected read raw `transforms`, so it wrote the pre-drag seed back
  // into the doc and silently reverted the drop.
  it('deleting a part before the drag solve lands keeps the dragged pose', () => {
    const { host, requestSolve } = mountHost(docWith(instance('p1'), instance('p2')))
    useAssemblyStore.setState({
      transforms: { p1: { ...IDENTITY_TRANSFORM, tx: 10 }, p2: { ...IDENTITY_TRANSFORM } },
    })
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([3, 0, 0])
    useAssemblyStore.getState().endPartManipulation()
    // Window: doc p1 = 13, settlingOffsets.p1 = 3, transforms.p1 = 10, no solve landed.
    const before = requestSolve.mock.calls.length

    useAssemblyStore.getState().setSelectedPartHandle('p2')
    useAssemblyStore.getState().deleteSelected()

    expect(findInstance(host.doc, 'p1')!.transform.tx).toBe(13)
    expect(findInstance(host.doc, 'p2')).toBeUndefined()
    expect(requestSolve.mock.calls.length).toBe(before + 1)
  })

  // A cancelled drag requests a restoring solve, but until it lands the pick
  // buffer must still describe what is drawn: the followers the abandoned drag
  // moved ride on the pick offset, while the grabbed part is back at its
  // settled pose. The old pickGeometryStale gate is gone, so nothing but this
  // offset keeps the two systems agreeing through the restore.
  it('a cancelled drag leaves the pick buffer following the moved followers', () => {
    mountHost(docWith(instance('p1'), instance('p2')))
    const p1 = pickBody('p1')
    const p2 = pickBody('p2')
    useAssemblyStore.setState({
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
      pickGeometry: [p1, p2],
      pickGeometryPose: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })

    const s = useAssemblyStore.getState()
    expect(s.beginPartManipulation('p1')).toBe(true)
    s.dragPartTranslate([3, 0, 0])
    // A live drag tick re-poses the follower p2; the pick snapshot stays baked.
    useAssemblyStore.getState().setDragSolveResult({
      transforms: { p2: { ...IDENTITY_TRANSFORM, tx: 7 } },
      bodies: {}, edgeCurves: {}, mateResults: {},
    })
    useAssemblyStore.getState().cancelPartManipulation()

    const state = useAssemblyStore.getState()
    expect(state.manipulation).toBeNull()
    const [movedP1, movedP2] = offsetPickBodies(
      state.pickGeometry, state.pickGeometryPose, state.settledPoses(),
    )
    expect(movedP1).toBe(p1)  // grabbed part back at its settled pose, no churn
    expect(movedP2).not.toBe(p2)
    expect(movedP2.faces!.positions[0]).toBeCloseTo(7, 9)
  })
})
