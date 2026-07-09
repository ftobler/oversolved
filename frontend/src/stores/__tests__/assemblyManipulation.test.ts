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

  it('drag-end writes the composed transform and triggers exactly one re-solve', () => {
    const { host, requestSolve } = mountHost(docWith(instance('p1'), instance('p2')))
    const s = useAssemblyStore.getState()

    expect(s.beginPartManipulation('p1')).toBe(true)
    s.dragPartTranslate([1, 0, 0])
    s.dragPartTranslate([3, 4, 0])  // pointer moved on; deltas are seed-relative
    expect(requestSolve).not.toHaveBeenCalled()  // no per-frame mate solve

    useAssemblyStore.getState().endPartManipulation()

    expect(requestSolve).toHaveBeenCalledTimes(1)
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 4, tz: 0 })
    expect(findInstance(host.doc, 'p2')!.transform).toEqual(IDENTITY_TRANSFORM)
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })

  it('gizmo rotation composes onto the instance quaternion and re-solves once', () => {
    const { host, requestSolve } = mountHost(docWith(instance('p1')))
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.rotatePartGizmo([0, 0, 1], HALF_PI)
    useAssemblyStore.getState().endPartManipulation()

    const q = findInstance(host.doc, 'p1')!.transform
    const x = rotateVector([q.qx, q.qy, q.qz, q.qw], [1, 0, 0])
    expect(x[0]).toBeCloseTo(0, 9)
    expect(x[1]).toBeCloseTo(1, 9)
    expect(requestSolve).toHaveBeenCalledTimes(1)
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
    s.dragPartTranslate([0, 0, 0])
    useAssemblyStore.getState().endPartManipulation()

    expect(host.doc).toBe(initial)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('cancelling a manipulation drops the session without touching the doc', () => {
    const initial = docWith(instance('p1'))
    const { host, requestSolve } = mountHost(initial)
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([5, 0, 0])
    useAssemblyStore.getState().cancelPartManipulation()
    useAssemblyStore.getState().endPartManipulation()

    expect(host.doc).toBe(initial)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('an unknown handle starts no session', () => {
    mountHost(docWith(instance('p1')))
    expect(useAssemblyStore.getState().beginPartManipulation('ghost')).toBe(false)
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
