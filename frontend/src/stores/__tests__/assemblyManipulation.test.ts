// Stage 6d: the store-level manipulation state machine. Viewport-free: the
// viewport only ever feeds it pointer deltas.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { findInstance } from '@/utils/assemblyMutations'
import { IDENTITY_TRANSFORM, rotateVector } from '@/utils/transform3d'

const HALF_PI = Math.PI / 2

function instance(handle: string, extra: Partial<PartInstance> = {}): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, ...extra }
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
    mutateDoc: (fn) => { host.doc = fn(host.doc) },
    requestSolve,
  })
  useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial })
  return { host, requestSolve }
}

describe('assemblyStore part manipulation', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    setAssemblyCallbacks(null)
  })

  it('each drag move re-solves live and the commit writes the composed transform', () => {
    const { host, requestSolve } = mountHost(docWith(instance('p1'), instance('p2')))
    const s = useAssemblyStore.getState()

    expect(s.beginPartManipulation('p1')).toBe(true)
    s.dragPartTranslate([1, 0, 0])
    s.dragPartTranslate([3, 4, 0])  // pointer moved on; deltas are seed-relative
    expect(requestSolve).toHaveBeenCalledTimes(2)  // one live solve per move

    useAssemblyStore.getState().endPartManipulation()

    expect(requestSolve).toHaveBeenCalledTimes(3)  // plus the final commit solve
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 4, tz: 0 })
    expect(findInstance(host.doc, 'p2')!.transform).toEqual(IDENTITY_TRANSFORM)
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })

  it('commit bakes each follower solved pose into its seed, not just the grabbed part', () => {
    const { host } = mountHost(docWith(instance('p1'), instance('p2')))
    // A prior solve left p2 (a follower) displayed away from its placement seed.
    useAssemblyStore.getState().setSnapshot({
      ...useAssemblyStore.getState(),
      transforms: {
        p1: { ...IDENTITY_TRANSFORM },
        p2: { ...IDENTITY_TRANSFORM, tx: 20, ty: 0, tz: 0 },
      },
    })
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([3, 0, 0])
    useAssemblyStore.getState().endPartManipulation()

    // The grabbed part lands its dragged pose; the follower's seed is refreshed
    // to its solved pose so the pointer-up solve does not restart from a stale
    // placement seed.
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3 })
    expect(findInstance(host.doc, 'p2')!.transform).toMatchObject({ tx: 20 })
  })

  it('gizmo rotation composes onto the instance quaternion and re-solves live then on commit', () => {
    const { host, requestSolve } = mountHost(docWith(instance('p1')))
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.rotatePartGizmo([0, 0, 1], HALF_PI)
    expect(requestSolve).toHaveBeenCalledTimes(1)  // live solve on the turn
    useAssemblyStore.getState().endPartManipulation()

    const q = findInstance(host.doc, 'p1')!.transform
    const x = rotateVector([q.qx, q.qy, q.qz, q.qw], [1, 0, 0])
    expect(x[0]).toBeCloseTo(0, 9)
    expect(x[1]).toBeCloseTo(1, 9)
    expect(requestSolve).toHaveBeenCalledTimes(2)  // plus the commit solve
  })

  it('a fixed instance is not manipulable by drag or gizmo', () => {
    const { host, requestSolve } = mountHost(docWith(instance('p1', { fixed: true })))
    const s = useAssemblyStore.getState()

    expect(s.beginPartManipulation('p1')).toBe(false)
    expect(useAssemblyStore.getState().manipulation).toBeNull()

    // The deltas a viewport would still emit land nowhere.
    s.dragPartTranslate([9, 9, 9])
    s.rotatePartGizmo([0, 0, 1], HALF_PI)
    useAssemblyStore.getState().endPartManipulation()

    expect(findInstance(host.doc, 'p1')!.transform).toEqual(IDENTITY_TRANSFORM)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('a click that never moves the part neither dirties the doc nor re-solves', () => {
    const initial = docWith(instance('p1'))
    const { host, requestSolve } = mountHost(initial)
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([0, 0, 0])  // a zero-delta click owes no live solve
    useAssemblyStore.getState().endPartManipulation()

    expect(host.doc).toBe(initial)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('cancelling a moved manipulation restores via a solve but never touches the doc', () => {
    const initial = docWith(instance('p1'))
    const { host, requestSolve } = mountHost(initial)
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([5, 0, 0])  // one live solve
    useAssemblyStore.getState().cancelPartManipulation()  // one restore solve
    useAssemblyStore.getState().endPartManipulation()  // session gone: no solve

    expect(host.doc).toBe(initial)
    // Live tick + restore, but the doc was never mutated.
    expect(requestSolve).toHaveBeenCalledTimes(2)
  })

  it('an unknown handle starts no session', () => {
    mountHost(docWith(instance('p1')))
    expect(useAssemblyStore.getState().beginPartManipulation('ghost')).toBe(false)
  })

  it('a live-drag result merges follower poses and leaves omitted parts (the grabbed one) intact', () => {
    mountHost(docWith(instance('p1'), instance('p2')))
    const seed = { ...IDENTITY_TRANSFORM, tx: 9 }
    // p1 is the grabbed part: it is not in the drag result, so its pose holds.
    useAssemblyStore.getState().setSnapshot({
      ...useAssemblyStore.getState(),
      transforms: { p1: seed, p2: { ...IDENTITY_TRANSFORM } },
    })

    useAssemblyStore.getState().setDragSolveResult({
      transforms: { p2: { ...IDENTITY_TRANSFORM, tx: 4 } },  // only the follower moved
      bodies: {},
      edgeCurves: {},
      mateResults: {},
    })

    const { transforms } = useAssemblyStore.getState()
    expect(transforms.p1).toEqual(seed)  // grabbed part untouched
    expect(transforms.p2).toMatchObject({ tx: 4 })  // follower updated
  })

  it('setSnapshot preserves the in-flight manipulation and the selection', () => {
    mountHost(docWith(instance('p1')))
    const s = useAssemblyStore.getState()
    s.setSelectedPartHandle('p1')
    s.beginPartManipulation('p1')
    s.dragPartTranslate([2, 0, 0])

    useAssemblyStore.getState().setSnapshot({
      ...useAssemblyStore.getState(),
      instances: [instance('p1')],
    })

    expect(useAssemblyStore.getState().manipulation?.current.tx).toBe(2)
    expect(useAssemblyStore.getState().selectedPartHandle).toBe('p1')
  })
})
