// Stage 6f: the pointer-to-store adapter, driven with synthetic hits and rays.
// It runs against the real assemblyStore (Stage 6d's state machine) so a passing
// test means a real drag would land a real transform.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { findInstance } from '@/utils/assemblyMutations'
import { createAssemblyPointerAdapter } from '@/utils/assemblyPointer'
import type { Ray } from '@/utils/gizmoMath'
import { IDENTITY_TRANSFORM, rotateVector } from '@/utils/transform3d'

const VIEW_NORMAL: [number, number, number] = [0, 0, -1]  // camera looking down -Z
const ray = (origin: [number, number, number], direction: [number, number, number]): Ray => ({ origin, direction })

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
  const store = useAssemblyStore.getState()
  // The swing angles are recorded on the way through: a drag past a half turn
  // is only observable frame by frame, since +190 and -170 end in the very same
  // orientation and the committed transform cannot tell them apart.
  const swings: number[] = []
  const adapter = createAssemblyPointerAdapter({
    beginPartManipulation: store.beginPartManipulation,
    dragPartTranslate: store.dragPartTranslate,
    rotatePartGizmo: (axis, angle, pivot) => {
      swings.push(angle)
      store.rotatePartGizmo(axis, angle, pivot)
    },
    endPartManipulation: store.endPartManipulation,
    cancelPartManipulation: store.cancelPartManipulation,
    setSelectedPartHandle: store.setSelectedPartHandle,
  })
  return { host, requestSolve, adapter, swings }
}

describe('assembly pointer adapter (body drag)', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    useAssemblyStore.getState().setSelectedPartHandle(null)
    setAssemblyCallbacks(null)
  })

  it('a hit on a free part opens one session and pointer-up commits once', () => {
    const { host, requestSolve, adapter } = mountHost(docWith(instance('p1')))

    expect(adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)).toBe(true)
    expect(adapter.isActive()).toBe(true)

    // Pointer drags to (3, 4) in the plane z = 0 facing the camera.
    adapter.onPointerMove(ray([3, 4, 10], [0, 0, -1]))
    expect(requestSolve).toHaveBeenCalledTimes(1)  // live solve: the rest follows

    adapter.onPointerUp()

    expect(requestSolve).toHaveBeenCalledTimes(2)  // plus the final commit solve
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 4, tz: 0 })
    expect(adapter.isActive()).toBe(false)
  })

  it('a hit on a fixed part selects it but starts no session', () => {
    const { host, requestSolve, adapter } = mountHost(docWith(instance('p1', { fixed: true })))

    expect(adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)).toBe(false)
    expect(useAssemblyStore.getState().selectedPartHandle).toBe('p1')
    expect(adapter.isActive()).toBe(false)

    // The move/up a viewport would still emit land nowhere.
    adapter.onPointerMove(ray([9, 9, 10], [0, 0, -1]))
    adapter.onPointerUp()

    expect(findInstance(host.doc, 'p1')!.transform).toEqual(IDENTITY_TRANSFORM)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('the drag delta is measured from the grab point, not the world origin', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))

    adapter.onBodyPointerDown('p1', [1, 1, 0], VIEW_NORMAL)
    adapter.onPointerMove(ray([4, 1, 10], [0, 0, -1]))
    adapter.onPointerUp()

    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 0, tz: 0 })
  })

  it('a pointer-up with no session commits nothing', () => {
    const { requestSolve, adapter } = mountHost(docWith(instance('p1')))
    adapter.onPointerUp()
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('cancel drops the session without touching the doc', () => {
    const initial = docWith(instance('p1'))
    const { host, requestSolve, adapter } = mountHost(initial)

    adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    adapter.onPointerMove(ray([5, 0, 10], [0, 0, -1]))  // one live solve
    adapter.cancel()  // one restore solve
    adapter.onPointerUp()

    expect(host.doc).toBe(initial)
    // Live tick then restore, but a cancelled drag never mutates the doc.
    expect(requestSolve).toHaveBeenCalledTimes(2)
  })
})

describe('assembly pointer adapter (triad gizmo)', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    setAssemblyCallbacks(null)
  })

  it('an arrow drag slides the part along that axis only', () => {
    const { host, requestSolve, adapter } = mountHost(docWith(instance('p1')))

    // Grab the X arrow while sighting down -Z at x = 1, then slide to x = 6.
    expect(adapter.onGizmoPointerDown('p1', 'translate', [1, 0, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))).toBe(true)
    adapter.onPointerMove(ray([6, 3, 10], [0, 0, -1]))  // live solve
    adapter.onPointerUp()

    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 5, ty: 0, tz: 0 })
    expect(requestSolve).toHaveBeenCalledTimes(2)  // live tick + commit
  })

  it('a ring drag swings the part about that axis', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))

    // Grab the Z ring at +X, swing to +Y: a quarter turn about Z.
    expect(adapter.onGizmoPointerDown('p1', 'rotate', [0, 0, 1], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))).toBe(true)
    adapter.onPointerMove(ray([0, 1, 10], [0, 0, -1]))
    adapter.onPointerUp()

    const t = findInstance(host.doc, 'p1')!.transform
    const x = rotateVector([t.qx, t.qy, t.qz, t.qw], [1, 0, 0])
    expect(x[0]).toBeCloseTo(0, 6)
    expect(x[1]).toBeCloseTo(1, 6)
  })

  it('a ring drag past a half turn keeps swinging the same way', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    // A pointer on the Z ring at `deg` around the gizmo, sighted down -Z.
    const armAt = (deg: number) => {
      const a = deg * Math.PI / 180
      return ray([Math.cos(a) * 5, Math.sin(a) * 5, 10], [0, 0, -1])
    }

    adapter.onGizmoPointerDown('p1', 'rotate', [0, 0, 1], [0, 0, 0], armAt(0))
    for (const deg of [90, 170, 250, 330, 400]) adapter.onPointerMove(armAt(deg))
    adapter.onPointerUp()

    const degrees = swings.map((rad) => rad * 180 / Math.PI)
    expect(degrees).toHaveLength(5)
    // Without unwrapping, atan2 would report 250 as -110 and the part would
    // snap back through most of a turn mid-drag.
    for (const [i, want] of [90, 170, 250, 330, 400].entries()) {
      expect(degrees[i]).toBeCloseTo(want, 6)
    }
  })

  it('a grounded part gets no gizmo session either', () => {
    const { requestSolve, adapter } = mountHost(docWith(instance('p1', { fixed: true })))
    expect(adapter.onGizmoPointerDown('p1', 'translate', [1, 0, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))).toBe(false)
    expect(adapter.isActive()).toBe(false)
    adapter.onPointerUp()
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('sighting straight down a translate arrow opens no session', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    // Ray parallel to the X arrow: no readable slide.
    expect(adapter.onGizmoPointerDown('p1', 'translate', [1, 0, 0], [0, 0, 0], ray([-9, 0, 0], [1, 0, 0]))).toBe(false)
    expect(adapter.isActive()).toBe(false)
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })

  it('a non-unit axis still slides by the world distance the pointer travelled', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown('p1', 'translate', [4, 0, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))
    adapter.onPointerMove(ray([6, 0, 10], [0, 0, -1]))
    adapter.onPointerUp()
    expect(findInstance(host.doc, 'p1')!.transform.tx).toBeCloseTo(5, 6)
  })
})
