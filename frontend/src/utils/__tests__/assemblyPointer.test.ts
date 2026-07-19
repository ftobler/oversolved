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
import { createAssemblyPointerAdapter, gestureAllowsSelect } from '@/utils/assemblyPointer'
import type { Ray } from '@/utils/gizmoMath'
import { IDENTITY_TRANSFORM, rotateVector, type Vec3 } from '@/utils/transform3d'

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
  // A committed drag leaves a render offset owed until the solve re-bakes the
  // bodies, and setSnapshot preserves it (it is store-owned); a fresh host is a
  // fresh scene, so it starts with none.
  useAssemblyStore.setState({ settlingOffsets: {} })
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
    setGizmoDrag: store.setGizmoDrag,
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
    expect(adapter.onGizmoPointerDown('p1', 'translate', 'x', [1, 0, 0], [0, 1, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))).toBe(true)
    adapter.onPointerMove(ray([6, 3, 10], [0, 0, -1]))  // live solve
    adapter.onPointerUp()

    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 5, ty: 0, tz: 0 })
    expect(requestSolve).toHaveBeenCalledTimes(2)  // live tick + commit
  })

  it('a ring drag swings the part about that axis', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))

    // Grab the Z ring at +X, swing to +Y: a quarter turn about Z.
    expect(adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))).toBe(true)
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

    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0))
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
    expect(adapter.onGizmoPointerDown('p1', 'translate', 'x', [1, 0, 0], [0, 1, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))).toBe(false)
    expect(adapter.isActive()).toBe(false)
    adapter.onPointerUp()
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('sighting straight down a translate arrow opens no session', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    // Ray parallel to the X arrow: no readable slide.
    expect(adapter.onGizmoPointerDown('p1', 'translate', 'x', [1, 0, 0], [0, 1, 0], [0, 0, 0], ray([-9, 0, 0], [1, 0, 0]))).toBe(false)
    expect(adapter.isActive()).toBe(false)
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })

  it('a non-unit axis still slides by the world distance the pointer travelled', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown('p1', 'translate', 'x', [4, 0, 0], [0, 1, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))
    adapter.onPointerMove(ray([6, 0, 10], [0, 0, -1]))
    adapter.onPointerUp()
    expect(findInstance(host.doc, 'p1')!.transform.tx).toBeCloseTo(5, 6)
  })
})

describe('assembly pointer adapter (ring angular snapping)', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    setAssemblyCallbacks(null)
  })

  /** A pointer on the Z ring at `deg` around the gizmo, sighted down -Z. */
  const armAt = (deg: number): Ray => {
    const a = deg * Math.PI / 180
    return ray([Math.cos(a) * 5, Math.sin(a) * 5, 10], [0, 0, -1])
  }

  /** The Z ring grabbed at +X, the frame `armAt(0)` puts the pointer in. */
  const grabZRing = (adapter: ReturnType<typeof mountHost>['adapter'], at = armAt(0)): boolean =>
    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], at)

  const lastDeg = (swings: number[]): number => swings[swings.length - 1] * 180 / Math.PI

  it('a swing inside the band is applied as an exact multiple of 15 degrees', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(88))  // 2 degrees short of a tick, inside the tolerance
    adapter.onPointerUp()

    expect(lastDeg(swings)).toBeCloseTo(90, 10)
  })

  it('a swing between two bands is applied untouched', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(82))  // 7 degrees off the nearest tick: free motion
    adapter.onPointerUp()

    expect(lastDeg(swings)).toBeCloseTo(82, 6)
  })

  // The unwrap accumulator must carry the RAW swing. Feeding the snapped angle
  // back would make later frames resolve their turn from the tick instead of
  // from where the cursor actually was, and a drag could never leave the tick it
  // last touched. A jump that straddles the half turn between the two is the one
  // motion that tells the two apart.
  it('the accumulator carries the raw swing, not the snapped one', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(88))  // snaps to 90, raw stays 88
    adapter.onPointerMove(armAt(269))  // 179 back from 88, but 181 on from 90
    adapter.onPointerUp()

    expect(lastDeg(swings)).toBeCloseTo(-90, 10)
  })

  it('an arrow drag is never snapped', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))

    adapter.onGizmoPointerDown('p1', 'translate', 'x', [1, 0, 0], [0, 1, 0], [0, 0, 0], ray([1, 0, 10], [0, 0, -1]))
    adapter.onPointerMove(ray([6.3, 0, 10], [0, 0, -1]))
    adapter.onPointerUp()

    expect(findInstance(host.doc, 'p1')!.transform.tx).toBeCloseTo(5.3, 6)
  })

  it('a plane drag is never snapped', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))

    adapter.onGizmoPointerDown('p1', 'plane', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], ray([0, 0, 10], [0, 0, -1]))
    adapter.onPointerMove(ray([1.7, 2.3, 10], [0, 0, -1]))
    adapter.onPointerUp()

    const t = findInstance(host.doc, 'p1')!.transform
    expect(t.tx).toBeCloseTo(1.7, 6)
    expect(t.ty).toBeCloseTo(2.3, 6)
  })
})

describe('gizmoDrag state', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    setAssemblyCallbacks(null)
  })

  const armAt = (deg: number): Ray => {
    const a = deg * Math.PI / 180
    return ray([Math.cos(a) * 5, Math.sin(a) * 5, 10], [0, 0, -1])
  }
  const gizmoDrag = () => useAssemblyStore.getState().gizmoDrag

  it('is null while nothing is grabbed', () => {
    mountHost(docWith(instance('p1')))
    expect(gizmoDrag()).toBeNull()
  })

  it('a body grab leaves it null: no triad handle is in play', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    expect(gizmoDrag()).toBeNull()
  })

  it('an arrow grab names the local axis, so the renderer needs no inverse rotation', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown('p1', 'translate', 'y', [0, 1, 0], [0, 0, 1], [0, 0, 0], ray([0, 1, 10], [0, 0, -1]))
    expect(gizmoDrag()).toEqual({ kind: 'axis', axis: 'y' })
  })

  it('a plane grab records its handle', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown('p1', 'plane', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], ray([1, 1, 10], [0, 0, -1]))
    expect(gizmoDrag()).toEqual({ kind: 'plane', axis: 'z' })
  })

  // The grab bearing is wherever the user clicked; the datum rounds it to a
  // quarter turn so the dial reads its sweep from a clean tick.
  it('a ring grab rounds the grab bearing to the nearest quarter turn', () => {
    const { adapter } = mountHost(docWith(instance('p1')))

    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(40))
    expect(gizmoDrag()).toEqual({ kind: 'ring', axis: 'z', datum: 0, swing: 0, snapped: true })

    adapter.onPointerUp()
    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(50))
    expect(gizmoDrag()!.kind).toBe('ring')
    expect((gizmoDrag() as { datum: number }).datum).toBeCloseTo(Math.PI / 2, 10)
  })

  // The dial draws the swing the part receives, so what is published is the
  // snapped angle, not the cursor's raw one.
  it('a ring move publishes the snapped swing and whether it snapped', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0))

    adapter.onPointerMove(armAt(88))
    expect((gizmoDrag() as { swing: number; snapped: boolean }).swing).toBeCloseTo(Math.PI / 2, 10)
    expect((gizmoDrag() as { snapped: boolean }).snapped).toBe(true)

    adapter.onPointerMove(armAt(82))
    expect((gizmoDrag() as { swing: number }).swing).toBeCloseTo(82 * Math.PI / 180, 10)
    expect((gizmoDrag() as { snapped: boolean }).snapped).toBe(false)
  })

  it('pointer-up clears it', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0))
    adapter.onPointerMove(armAt(30))
    adapter.onPointerUp()
    expect(gizmoDrag()).toBeNull()
  })

  it('cancel clears it', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0))
    adapter.onPointerMove(armAt(30))
    adapter.cancel()
    expect(gizmoDrag()).toBeNull()
  })

  // A handle that opens no session must leave no drag behind, or the triad would
  // narrow to a gesture that is not running.
  it('a refused grab leaves it null', () => {
    const { adapter } = mountHost(docWith(instance('p1', { fixed: true })))
    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0))
    expect(gizmoDrag()).toBeNull()
  })
})

describe('assembly pointer adapter (triad plane handles)', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    setAssemblyCallbacks(null)
  })

  it('a drag on the XY quad moves in that plane and never out of it', () => {
    const { host, requestSolve, adapter } = mountHost(docWith(instance('p1')))

    // Grab the XY plane handle (normal +Z) sighting from an oblique direction,
    // so a hit off the z = 0 plane would show up as a non-zero tz.
    expect(adapter.onGizmoPointerDown('p1', 'plane', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], ray([1, 1, 10], [0, 0, -1]))).toBe(true)
    adapter.onPointerMove(ray([4, -2, 6], [1, 0, -1]))
    adapter.onPointerUp()

    const t = findInstance(host.doc, 'p1')!.transform
    expect(t.tx).toBeCloseTo(9, 6)   // the ray reaches z = 0 at x = 4 + 6
    expect(t.ty).toBeCloseTo(-3, 6)
    expect(t.tz).toBeCloseTo(0, 6)   // the whole point: no motion out of plane
    expect(requestSolve).toHaveBeenCalledTimes(2)  // live tick + commit
  })

  it('the plane is the part-axis one, not the view plane', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))

    // YZ handle: normal +X, so X must not move however the pointer travels.
    // The rays come in at 45 degrees; sighting down -Z would graze the quad.
    adapter.onGizmoPointerDown('p1', 'plane', 'x', [1, 0, 0], [0, 1, 0], [0, 0, 0], ray([5, 0, 5], [-1, 0, -1]))
    adapter.onPointerMove(ray([5, 5, 5], [-1, 0, -1]))
    adapter.onPointerUp()

    const t = findInstance(host.doc, 'p1')!.transform
    expect(t.tx).toBeCloseTo(0, 6)
    expect(t.ty).toBeCloseTo(5, 6)
  })

  it('a ray grazing the quad opens no session', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    // Sighting along the XY plane: the ray never meets it in one point.
    expect(adapter.onGizmoPointerDown('p1', 'plane', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], ray([-9, 0, 0], [1, 0, 0]))).toBe(false)
    expect(adapter.isActive()).toBe(false)
    expect(useAssemblyStore.getState().manipulation).toBeNull()
  })

  it('a grounded part gets no plane session either', () => {
    const { requestSolve, adapter } = mountHost(docWith(instance('p1', { fixed: true })))
    expect(adapter.onGizmoPointerDown('p1', 'plane', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], ray([1, 1, 10], [0, 0, -1]))).toBe(false)
    expect(adapter.isActive()).toBe(false)
    adapter.onPointerUp()
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('the body grab and a plane handle run the very same gesture', () => {
    // Both are a plane-constrained drag; the body's plane is just the one
    // facing the camera. A regression that splits them would show here.
    const bodyRun = mountHost(docWith(instance('p1')))
    bodyRun.adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    bodyRun.adapter.onPointerMove(ray([3, 4, 10], [0, 0, -1]))
    bodyRun.adapter.onPointerUp()

    const handleRun = mountHost(docWith(instance('p1')))
    // VIEW_NORMAL is -Z, so the equivalent handle is the XY quad grabbed at
    // the gizmo origin, which is where the body grab point sat too.
    handleRun.adapter.onGizmoPointerDown('p1', 'plane', 'z', VIEW_NORMAL, [1, 0, 0], [0, 0, 0], ray([0, 0, 10], [0, 0, -1]))
    handleRun.adapter.onPointerMove(ray([3, 4, 10], [0, 0, -1]))
    handleRun.adapter.onPointerUp()

    expect(findInstance(handleRun.host.doc, 'p1')!.transform)
      .toEqual(findInstance(bodyRun.host.doc, 'p1')!.transform)
  })
})

describe('click versus manipulation at pointer-up', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    useAssemblyStore.getState().setSelectedPartHandle(null)
    setAssemblyCallbacks(null)
  })

  it('a pointer-up with no session leaves the plain click alone', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    const gesture = adapter.onPointerUp()
    expect(gesture).toEqual({ source: null, moved: false })
    expect(gestureAllowsSelect(gesture)).toBe(true)
  })

  it('a body click that never moved is still a select', () => {
    const { requestSolve, adapter } = mountHost(docWith(instance('p1')))

    adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    const gesture = adapter.onPointerUp()

    expect(gesture).toEqual({ source: 'body', moved: false })
    expect(gestureAllowsSelect(gesture)).toBe(true)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('a pointermove landing back on the grab point still counts as a click', () => {
    const { adapter } = mountHost(docWith(instance('p1')))

    adapter.onBodyPointerDown('p1', [2, 3, 0], VIEW_NORMAL)
    adapter.onPointerMove(ray([2, 3, 10], [0, 0, -1]))  // same pixel, zero delta
    const gesture = adapter.onPointerUp()

    expect(gesture.moved).toBe(false)
    expect(gestureAllowsSelect(gesture)).toBe(true)
  })

  // The re-solve a moved drag commits drops the B-rep selection (its keys are
  // positional), so selecting here would only make a highlight that vanishes
  // when the solve lands. Even a drag too short to pass the viewport's click
  // threshold moved the part, and is therefore a drag.
  it('a body drag that moved the part is never a select', () => {
    const { adapter } = mountHost(docWith(instance('p1')))

    adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    adapter.onPointerMove(ray([0.01, 0, 10], [0, 0, -1]))  // a hair, under any threshold
    const gesture = adapter.onPointerUp()

    expect(gesture).toEqual({ source: 'body', moved: true })
    expect(gestureAllowsSelect(gesture)).toBe(false)
  })

  // The handle is drawn over the part, so a face behind it is not what the user
  // pointed at. Clicking an arrow, ring or quad must never toggle it in.
  it.each([
    ['translate' as const, 'x' as const, [1, 0, 0] as Vec3, [0, 1, 0] as Vec3],
    ['rotate' as const, 'z' as const, [0, 0, 1] as Vec3, [1, 0, 0] as Vec3],
    ['plane' as const, 'z' as const, [0, 0, 1] as Vec3, [1, 0, 0] as Vec3],
  ])('a %s handle click selects nothing behind the gizmo', (mode, name, axis, reference) => {
    const { adapter } = mountHost(docWith(instance('p1')))

    expect(adapter.onGizmoPointerDown('p1', mode, name, axis, reference, [0, 0, 0], ray([1, 1, 10], [0, 0, -1]))).toBe(true)
    const gesture = adapter.onPointerUp()

    expect(gesture).toEqual({ source: 'gizmo', moved: false })
    expect(gestureAllowsSelect(gesture)).toBe(false)
  })

  it('a grounded part opens no session, so its click still selects', () => {
    const { adapter } = mountHost(docWith(instance('p1', { fixed: true })))

    expect(adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)).toBe(false)
    expect(gestureAllowsSelect(adapter.onPointerUp())).toBe(true)
  })
})
