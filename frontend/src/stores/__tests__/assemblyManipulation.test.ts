// Stage 6d: the store-level manipulation state machine. Viewport-free: the
// viewport only ever feeds it pointer deltas.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc, BodyResult, PartInstance, Transform3D } from '@/types/cad'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { findInstance } from '@/utils/assemblyMutations'
import { getAssemblyPartGroups } from '@/utils/assemblyRender'
import { composeTransforms, IDENTITY_TRANSFORM, makeTransform, rotateVector } from '@/utils/transform3d'

const HALF_PI = Math.PI / 2

function instance(handle: string, extra: Partial<PartInstance> = {}): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, ...extra }
}

/** A one-triangle body, enough for the render path to emit a group for `handle`. */
function solvedBody(handle: string): BodyResult {
  return {
    id: `${handle}:body_0`,
    created_by: handle,
    modified_by: [],
    mesh: { vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), faces: new Uint32Array([0, 1, 2]) },
  }
}

function docWith(...instances: PartInstance[]): AssemblyDoc {
  return {
    kind: 'assembly',
    features: instances.map((inst, i) => ({ id: `f${i}`, kind: 'part_instance' as const, instance: inst })),
  }
}

/**
 * What the screen actually shows for `handle`: the render path's group offset
 * applied over vertices baked at `baked`, which is the pose the last solve to
 * touch this part left in its mesh.
 */
function drawnPose(handle: string, baked: Transform3D): Transform3D {
  const { manipulation, settlingOffsets } = useAssemblyStore.getState()
  const group = getAssemblyPartGroups(
    { [`${handle}:body_0`]: solvedBody(handle) },
    [instance(handle)],
    manipulation,
    null,
    settlingOffsets,
  )[0]
  return composeTransforms(makeTransform(group.position, group.quaternion), baked)
}

/** Stands in for the AssemblyEditor: owns the doc, counts re-solves. */
function mountHost(initial: AssemblyDoc) {
  const requestSolve = vi.fn()
  const host = { doc: initial }
  // Every committed mutation is a potential undo step; the page's mutate pushes
  // the pre-doc, so the harness records it the same way for drag-undo tests.
  const pushes: Array<{ doc: AssemblyDoc; label: string }> = []
  setAssemblyCallbacks({
    mutateDoc: (label, fn) => {
      pushes.push({ doc: host.doc, label })
      host.doc = fn(host.doc)
    },
    mutateDocSession: (label, fn) => {
      pushes.push({ doc: host.doc, label })
      host.doc = fn(host.doc)
    },
    requestSolve,
  })
  useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: initial })
  return { host, requestSolve, pushes }
}

describe('assemblyStore part manipulation', () => {
  beforeEach(() => {
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().cancelPartManipulation()
    // Store-owned, so setSnapshot preserves it: a committed drag would otherwise
    // carry its offset into the next test.
    useAssemblyStore.setState({ settlingOffsets: {} })
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

  // The seed is the DOC pose, but a mate can have pulled the part away from it,
  // and the viewport draws the grabbed part at (drag delta) over its SOLVED pose.
  // Committing `session.current` (delta over the seed) would drop the part back
  // by exactly (solved - seed) the instant the pointer is released.
  it('commits the grabbed part where the viewport drew it, not delta over the stale seed', () => {
    const { host } = mountHost(docWith(instance('p1'), instance('p2')))
    // A mate pulled p1 10mm off its placement seed on the last full solve.
    const solvedP1 = { ...IDENTITY_TRANSFORM, tx: 10 }
    useAssemblyStore.getState().setSnapshot({
      ...useAssemblyStore.getState(),
      transforms: { p1: solvedP1, p2: { ...IDENTITY_TRANSFORM, tx: 20 } },
    })
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([3, 0, 0])

    // What the screen actually shows: the group offset the render path emits,
    // applied over vertices already baked at the solved pose.
    const manipulation = useAssemblyStore.getState().manipulation!
    const group = getAssemblyPartGroups(
      { 'p1:body_0': solvedBody('p1') },
      [instance('p1')],
      manipulation,
      null,
    )[0]
    const drawn = composeTransforms(makeTransform(group.position, group.quaternion), solvedP1)

    useAssemblyStore.getState().endPartManipulation()

    expect(drawn.tx).toBeCloseTo(13, 9)  // guards the derivation itself
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: drawn.tx, ty: drawn.ty, tz: drawn.tz })
  })

  // The commit reaches the doc a solve round trip before the bodies are re-meshed
  // at the new pose. Dropping the render offset on pointer-up drew the part back
  // at its pre-drag mesh for that whole window: the snap-back the user sees.
  it('keeps the part drawn where it was dropped until the solve re-bakes it', () => {
    mountHost(docWith(instance('p1')))
    const solvedP1 = { ...IDENTITY_TRANSFORM, tx: 10 }
    useAssemblyStore.getState().setSnapshot({
      ...useAssemblyStore.getState(),
      transforms: { p1: solvedP1 },
    })
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([3, 0, 0])
    useAssemblyStore.getState().endPartManipulation()

    const drawnAfterRelease = drawnPose('p1', solvedP1)
    expect(drawnAfterRelease.tx).toBeCloseTo(13, 9)  // not back at the solved 10

    // The solve returns with the body baked at its committed pose; the offset it
    // stood in for is retired, or the part would render 3mm past the drop.
    useAssemblyStore.getState().setSolveResult({
      transforms: { p1: { ...IDENTITY_TRANSFORM, tx: 13 } },
      bodies: {}, edgeCurves: {}, entityMateRefs: {}, anchors: {}, pickGeometry: [], mateResults: {},
    })
    expect(useAssemblyStore.getState().settlingOffsets).toEqual({})
    expect(drawnPose('p1', { ...IDENTITY_TRANSFORM, tx: 13 }).tx).toBeCloseTo(13, 9)
  })

  // Grabbing again before the pointer-up solve lands means the mesh is still
  // baked two poses back: the new drag has to ride on the offset it owes, and
  // the commit has to compose against the drawn pose, not the stale solved one.
  it('a second drag before the solve returns stacks on the offset still owed', () => {
    const { host } = mountHost(docWith(instance('p1')))
    useAssemblyStore.getState().setSnapshot({
      ...useAssemblyStore.getState(),
      transforms: { p1: { ...IDENTITY_TRANSFORM } },
    })

    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([3, 0, 0])
    useAssemblyStore.getState().endPartManipulation()

    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([0, 5, 0])
    expect(drawnPose('p1', IDENTITY_TRANSFORM)).toMatchObject({ tx: 3, ty: 5 })

    useAssemblyStore.getState().endPartManipulation()
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 5, tz: 0 })
    expect(drawnPose('p1', IDENTITY_TRANSFORM)).toMatchObject({ tx: 3, ty: 5 })
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

  // The gizmo-drag undo step: the commit hands the page one pre-drag doc with a
  // descriptive label, so a store-level drag feeds the page's undo funnel just
  // like any other mutation (assemblyManipulation keeps pointer drags here).
  it('a committed drag pushes one undo step holding the pre-drag doc', () => {
    const initial = docWith(instance('p1'), instance('p2'))
    const { host, pushes } = mountHost(initial)
    const s = useAssemblyStore.getState()

    s.beginPartManipulation('p1')
    s.dragPartTranslate([3, 4, 0])
    useAssemblyStore.getState().endPartManipulation()

    expect(pushes).toHaveLength(1)
    expect(pushes[0].label).toBe('Move part')
    expect(pushes[0].doc).toBe(initial)  // the pre-drag doc, by reference
    expect(findInstance(host.doc, 'p1')!.transform).toMatchObject({ tx: 3, ty: 4, tz: 0 })
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

  // Why the viewport's auto-fit has to be abandoned on grab rather than merely
  // deferred (shouldAutoFit): every live tick hands out a fresh `bodies` object,
  // so anything keyed on its identity re-fires throughout the whole gesture.
  it('a live-drag result replaces the bodies record identity even when it adds nothing', () => {
    mountHost(docWith(instance('p1')))
    const before = useAssemblyStore.getState().bodies

    useAssemblyStore.getState().setDragSolveResult({
      transforms: {}, bodies: {}, edgeCurves: {}, mateResults: {},
    })

    expect(useAssemblyStore.getState().bodies).not.toBe(before)
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
