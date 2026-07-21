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
import { dialCounterRotation, dialSpoke, dialTicks, nearestTickIndex } from '@/utils/angleDialGeometry'
import { signedAngleAbout, type Ray } from '@/utils/gizmoMath'
import { GIZMO_AXES, GIZMO_PIXELS, RING_RADIUS, type GizmoAxisDef } from '@/utils/gizmoPickGeometry'
import { manipulationDelta } from '@/utils/partManipulation'
import {
  composeTransforms, IDENTITY_TRANSFORM, quatMultiply, rotateVector, transformQuat, type Quat, type Vec3,
} from '@/utils/transform3d'

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
    beginBodyDrag: store.beginBodyDrag,
    setDragTarget: store.setDragTarget,
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

// A body grab is solver-driven now (the rigid, grab-point rework): the adapter
// captures the grab point and feeds the cursor as the target, and the SOLVED pose
// drives the part. With no solver mounted here the store's manipulation.current is
// only advanced by a simulated solve (setDragSolvedPose), which stands in for what
// useAssemblySolve does after each live solve.
describe('assembly pointer adapter (body drag)', () => {
  const IDENT = { ...IDENTITY_TRANSFORM }
  const solved = (tx: number, ty: number) => useAssemblyStore.getState().setDragSolvedPose({ ...IDENT, tx, ty, tz: 0 })

  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    useAssemblyStore.getState().setSelectedPartHandle(null)
    setAssemblyCallbacks(null)
  })

  it('opens a session, targets the cursor world point, and re-solves on the move', () => {
    const { requestSolve, adapter } = mountHost(docWith(instance('p1')))

    expect(adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)).toBe(true)
    expect(adapter.isActive()).toBe(true)

    // Pointer drags to (3, 4) in the plane z = 0 facing the camera.
    adapter.onPointerMove(ray([3, 4, 10], [0, 0, -1]))
    expect(requestSolve).toHaveBeenCalledTimes(1)  // live solve: the whole scene follows
    // The objective pulls the grab point to the cursor's world position on the plane.
    expect(useAssemblyStore.getState().manipulation!.dragObjective!.target).toEqual([3, 4, 0])
  })

  it('commits the SOLVED pose the drag solve produced, not the raw cursor', () => {
    const { host, requestSolve, adapter } = mountHost(docWith(instance('p1')))

    adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    adapter.onPointerMove(ray([3, 4, 10], [0, 0, -1]))
    // The solver brought the free part's grab point onto the cursor: pose (3, 4).
    solved(3, 4)
    adapter.onPointerUp()

    expect(requestSolve).toHaveBeenCalledTimes(2)  // live tick + commit
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 4, tz: 0 })
    expect(adapter.isActive()).toBe(false)
  })

  // Rigid, no stretch: if the solver could only reach part-way (a constraint held
  // the part back), the committed pose is that solved pose, never the cursor.
  it('commits where the constraints allowed, not where the pointer went', () => {
    const { host, adapter } = mountHost(docWith(instance('p1')))

    adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    adapter.onPointerMove(ray([10, 10, 10], [0, 0, -1]))  // cursor way out at (10, 10)
    solved(2, 0)  // the solver only got the part to (2, 0)
    adapter.onPointerUp()

    // The committed pose is the solved one, not the (10, 10) the pointer asked for.
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 2, ty: 0, tz: 0 })
  })

  it('captures the grab point in the part frame', () => {
    const { adapter } = mountHost(docWith(instance('p1')))

    adapter.onBodyPointerDown('p1', [1, 1, 0], VIEW_NORMAL)
    adapter.onPointerMove(ray([4, 1, 10], [0, 0, -1]))

    const obj = useAssemblyStore.getState().manipulation!.dragObjective!
    // Part at identity, so the local grab equals the world grab; the target is the
    // cursor's world point on the grab plane.
    expect(obj.localGrab).toEqual([1, 1, 0])
    expect(obj.target).toEqual([4, 1, 0])
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
    solved(5, 0)  // the solve landed, so the part has moved
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

  it('a fixed part gets no gizmo session either', () => {
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

// "Pull away for precision": the cursor's distance from the ring centre is a
// master switch over the tolerance band. Inside the drawn circle the drag clicks
// onto the ticks as before; pull the cursor out past the ring and every angle is
// free, however close to a tick it lands. The threshold is the ring's own world
// radius, which moves with the camera because the triad is screen-scaled.
describe('assembly pointer adapter (radius-gated snapping)', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    setAssemblyCallbacks(null)
  })

  // One gizmo unit is 10 world units here, so the ring's rim sits at 7.5: a
  // sample at radius 5 is inside the circle and one at 12 is outside it.
  const SCALE = 10
  const INSIDE = RING_RADIUS * SCALE - 2.5
  const OUTSIDE = RING_RADIUS * SCALE + 4.5

  /** A pointer on the Z ring at `deg` around the gizmo and `radius` out, sighted down -Z. */
  const armAt = (deg: number, radius: number): Ray => {
    const a = deg * Math.PI / 180
    return ray([Math.cos(a) * radius, Math.sin(a) * radius, 10], [0, 0, -1])
  }

  const grabZRing = (adapter: ReturnType<typeof mountHost>['adapter']): boolean =>
    adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0, INSIDE))

  const lastDeg = (swings: number[]): number => swings[swings.length - 1] * 180 / Math.PI
  const drag = () => useAssemblyStore.getState().gizmoDrag as { swing: number; snapArmed: boolean }

  it('a drag inside the circle and inside the band still snaps', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(88, INSIDE), SCALE)

    expect(lastDeg(swings)).toBeCloseTo(90, 10)
  })

  // The pair that pins the feature: the only difference between this and the
  // test above is how far out the cursor is.
  it('the same angle sampled outside the circle is left alone', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(88, OUTSIDE), SCALE)

    expect(lastDeg(swings)).toBeCloseTo(88, 6)
  })

  it('crossing the boundary mid-drag arms and disarms without a jump in between', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(88, INSIDE), SCALE)
    expect(lastDeg(swings)).toBeCloseTo(90, 10)

    adapter.onPointerMove(armAt(88, OUTSIDE), SCALE)  // pulled away, same bearing
    expect(lastDeg(swings)).toBeCloseTo(88, 6)

    adapter.onPointerMove(armAt(88, INSIDE), SCALE)  // back in, clicks again
    expect(lastDeg(swings)).toBeCloseTo(90, 10)
  })

  // The gate must not touch the accumulator any more than the band does. A jump
  // straddling the half turn is the one motion that can tell the raw swing from
  // the snapped one, so it is run here from a DISARMED reading: if a disarmed
  // frame ever fed something other than the cursor's own angle forward, this
  // would resolve the turn the other way and land on 270.
  it('an unarmed frame leaves the raw swing accumulator untouched', () => {
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(88, OUTSIDE), SCALE)  // free 88, raw 88
    adapter.onPointerMove(armAt(269, INSIDE), SCALE)  // 179 back from 88, but 181 on from 90

    expect(lastDeg(swings)).toBeCloseTo(-90, 10)
  })

  it('publishes snapArmed on gizmoDrag and tracks the crossing', () => {
    const { adapter } = mountHost(docWith(instance('p1')))

    // The grab lands on the ring itself, so a drag opens armed.
    grabZRing(adapter)
    expect(drag().snapArmed).toBe(true)

    adapter.onPointerMove(armAt(88, OUTSIDE), SCALE)
    expect(drag().snapArmed).toBe(false)

    adapter.onPointerMove(armAt(88, INSIDE), SCALE)
    expect(drag().snapArmed).toBe(true)
  })

  it('a caller that supplies no scale keeps snapping armed', () => {
    // The viewport always has a camera to measure, but a drag must never lose a
    // feature because some other caller could not answer where the ring is.
    const { adapter, swings } = mountHost(docWith(instance('p1')))

    grabZRing(adapter)
    adapter.onPointerMove(armAt(88, OUTSIDE))

    expect(lastDeg(swings)).toBeCloseTo(90, 10)
  })

  // The triad holds a constant size on SCREEN, so its world radius is
  // GIZMO_PIXELS * p2w(camera), and p2w is 1 / zoom for the orthographic camera
  // the assembly uses. Zooming in therefore SHRINKS the circle in world units,
  // and one unmoved world sample can fall out of a ring it was inside of.
  it('the threshold follows the gizmo world scale, so zoom decides the same sample', () => {
    const scaleAtZoom = (zoom: number) => GIZMO_PIXELS / zoom
    const sample = RING_RADIUS * scaleAtZoom(30)  // exactly the rim at zoom 30

    const out = mountHost(docWith(instance('p1')))
    out.adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0, sample))
    out.adapter.onPointerMove(armAt(88, sample), scaleAtZoom(15))  // zoomed out: ring is twice as wide
    expect(lastDeg(out.swings)).toBeCloseTo(90, 10)

    const inn = mountHost(docWith(instance('p1')))
    inn.adapter.onGizmoPointerDown('p1', 'rotate', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], armAt(0, sample))
    inn.adapter.onPointerMove(armAt(88, sample), scaleAtZoom(60))  // zoomed in: the rim has shrunk past it
    expect(lastDeg(inn.swings)).toBeCloseTo(88, 6)
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
    expect(gizmoDrag()).toEqual({ kind: 'ring', axis: 'z', datum: 0, swing: 0, snapped: true, snapArmed: true })

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

  // A triad narrowed to a gesture nobody is holding is unusable: eight of its
  // nine handles are gone from the screen while the pick layer still registers
  // them. A release clears the drag even when it finds no gesture to end.
  it('a pointer-up with no session clears a drag left standing', () => {
    const { adapter } = mountHost(docWith(instance('p1')))
    useAssemblyStore.getState().setGizmoDrag({ kind: 'axis', axis: 'x' })
    adapter.onPointerUp()
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

  it('a fixed part gets no plane session either', () => {
    const { requestSolve, adapter } = mountHost(docWith(instance('p1', { fixed: true })))
    expect(adapter.onGizmoPointerDown('p1', 'plane', 'z', [0, 0, 1], [1, 0, 0], [0, 0, 0], ray([1, 1, 10], [0, 0, -1]))).toBe(false)
    expect(adapter.isActive()).toBe(false)
    adapter.onPointerUp()
    expect(requestSolve).not.toHaveBeenCalled()
  })

  // The body grab and the plane handle are now DIFFERENT gestures: the body grab
  // is solver-driven (drag objective, no gizmoDrag state), the plane handle is a
  // geometric translation of the whole part (a triad drag). This asserts the
  // split rather than the old equivalence -- the body grab opens no triad drag.
  it('the body grab is solver-driven while the plane handle is a geometric triad drag', () => {
    const bodyRun = mountHost(docWith(instance('p1')))
    bodyRun.adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)
    bodyRun.adapter.onPointerMove(ray([3, 4, 10], [0, 0, -1]))
    expect(useAssemblyStore.getState().manipulation!.dragObjective).toBeDefined()
    expect(useAssemblyStore.getState().gizmoDrag).toBeNull()
    bodyRun.adapter.onPointerUp()

    const handleRun = mountHost(docWith(instance('p1')))
    handleRun.adapter.onGizmoPointerDown('p1', 'plane', 'z', VIEW_NORMAL, [1, 0, 0], [0, 0, 0], ray([0, 0, 10], [0, 0, -1]))
    handleRun.adapter.onPointerMove(ray([3, 4, 10], [0, 0, -1]))
    // A triad drag carries no drag objective and does publish a gizmoDrag.
    expect(useAssemblyStore.getState().manipulation!.dragObjective).toBeUndefined()
    expect(useAssemblyStore.getState().gizmoDrag).toEqual({ kind: 'plane', axis: 'z' })
    handleRun.adapter.onPointerUp()
    // The triad drag still commits its geometric translation with no solver.
    expect(findInstance(handleRun.host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 4, tz: 0 })
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

  it('a fixed part opens no session, so its click still selects', () => {
    const { adapter } = mountHost(docWith(instance('p1', { fixed: true })))

    expect(adapter.onBodyPointerDown('p1', [0, 0, 0], VIEW_NORMAL)).toBe(false)
    expect(gestureAllowsSelect(adapter.onPointerUp())).toBe(true)
  })
})

// The one composition nothing else covers: the angles the store publishes are
// measured in the PRE-DRAG frame, while TriadGizmo nests the dial inside a group
// posed with the part's LIVE orientation. Every assertion here therefore drives a
// real ring drag, rebuilds the gizmo pose exactly as assemblyRender's `gizmoPose`
// does, and asks where the dial's lines actually land in the world.
//
// A protractor is what is being checked: the datum line and the tick grid stay
// put while the part turns under them, and only the live line sweeps. Drop the
// dial's counter-rotation and the datum tracks the cursor while the live line
// runs at twice its rate, which is what the wedge's correct WIDTH hides.
describe('the angle dial as drawn through the drag pose', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    setAssemblyCallbacks(null)
  })

  const DEG = Math.PI / 180
  const deg = (rad: number): number => rad / DEG

  /** A pointer on `def`'s ring at `bearing` degrees from `def.u`, sighted down the axis. */
  const armAt = (def: GizmoAxisDef, bearing: number): Ray => {
    const a = bearing * DEG
    const { u, v, axis } = def
    const at = (i: 0 | 1 | 2) => u[i] * Math.cos(a) * 5 + v[i] * Math.sin(a) * 5 + axis[i] * 10
    return ray([at(0), at(1), at(2)], [-axis[0], -axis[1], -axis[2]])
  }

  /**
   * Runs a ring drag and returns the world quaternion the AngleDial's own group
   * ends up with: the triad group's pose (`gizmoPose`) carrying the dial's local
   * counter-rotation, which is precisely the nesting TriadGizmo renders.
   */
  function dragRing(def: GizmoAxisDef, grabBearing: number, toBearing: number) {
    const { adapter } = mountHost(docWith(instance('p1')))
    adapter.onGizmoPointerDown(
      'p1', 'rotate', def.name, def.axis, def.u, [0, 0, 0], armAt(def, grabBearing),
    )
    adapter.onPointerMove(armAt(def, toBearing))

    const state = useAssemblyStore.getState()
    const drag = state.gizmoDrag as { kind: 'ring'; datum: number; swing: number }
    // The seed is identity here, so the pre-drag frame is the world frame and a
    // bearing read against `def.u` is a world bearing.
    const pose = composeTransforms(manipulationDelta(state.manipulation!), IDENTITY_TRANSFORM)
    const dialQuat = quatMultiply(transformQuat(pose), dialCounterRotation(def, drag.swing))
    return { drag, dialQuat }
  }

  /** Where a point drawn in the dial's local frame ends up, as a world bearing. */
  const bearingOf = (def: GizmoAxisDef, dialQuat: Quat, local: Vec3): number =>
    deg(signedAngleAbout(def.axis, def.u, rotateVector(dialQuat, local)))

  // Grab bearings are deliberately off a quarter turn (40 rounds to 0, 130 to
  // 90), so a datum that silently followed the raw grab arm would show up too.
  it.each([
    ['x', 40, 130, 90],
    ['y', 40, 130, 90],
    ['z', 40, 130, 90],
    ['z', 130, 40, -90],
    ['x', 40, -50, -90],
  ])('the %s ring grabbed at %i and dragged to %i keeps its datum pinned', (name, grab, to, wantSwing) => {
    const def = GIZMO_AXES.find(a => a.name === name)!
    const { drag, dialQuat } = dragRing(def, grab, to)

    expect(deg(drag.swing)).toBeCloseTo(wantSwing, 6)

    const datumEnd = dialSpoke(def, drag.datum)[1]
    const liveEnd = dialSpoke(def, drag.datum + drag.swing)[1]
    // The datum marks where the rotation STARTED, so the part swinging under it
    // must not move it; the live line carries the whole of the applied swing.
    expect(bearingOf(def, dialQuat, datumEnd)).toBeCloseTo(deg(drag.datum), 6)
    expect(bearingOf(def, dialQuat, liveEnd)).toBeCloseTo(deg(drag.datum) + wantSwing, 6)
  })

  it('the tick grid stays on world snap bearings while the part turns', () => {
    const def = GIZMO_AXES.find(a => a.name === 'z')!
    const { drag, dialQuat } = dragRing(def, 40, 122.5)  // 82.5, midway between two bands: free motion

    const ticks = dialTicks(def)
    for (const tick of ticks) {
      const drawn = bearingOf(def, dialQuat, tick.end)
      // Every tick must still sit on a multiple of the snap step in world, or a
      // highlighted tick would advertise a bearing the part cannot snap to.
      expect(Math.abs(drawn / 15 - Math.round(drawn / 15))).toBeLessThan(1e-6)
    }
    expect(bearingOf(def, dialQuat, ticks[0].end)).toBeCloseTo(0, 6)
    expect(drag.swing).toBeCloseTo(82.5 * DEG, 6)
  })

  it('the highlighted tick sits under the live line when the swing snapped', () => {
    const def = GIZMO_AXES.find(a => a.name === 'y')!
    const { drag, dialQuat } = dragRing(def, 40, 128)  // 88 pulls onto the 90 tick

    const lit = dialTicks(def)[nearestTickIndex(drag.datum + drag.swing)]
    const liveEnd = dialSpoke(def, drag.datum + drag.swing)[1]
    expect(bearingOf(def, dialQuat, lit.end)).toBeCloseTo(bearingOf(def, dialQuat, liveEnd), 6)
  })
})
