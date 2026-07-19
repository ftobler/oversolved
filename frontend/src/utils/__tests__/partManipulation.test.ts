import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import {
  beginManipulation,
  commitManipulation,
  dragTranslate,
  gizmoRotate,
  isManipulable,
  livePartPose,
} from '@/utils/partManipulation'
import { findInstance } from '@/utils/assemblyMutations'
import { IDENTITY_TRANSFORM, quatFromAxisAngle, makeTransform, rotateVector } from '@/utils/transform3d'

const HALF_PI = Math.PI / 2

function docWith(...instances: PartInstance[]): AssemblyDoc {
  return {
    kind: 'assembly',
    features: instances.map((instance, i) => ({
      id: `feat-${i}`,
      kind: 'part_instance' as const,
      instance,
    })),
  }
}

function instance(handle: string, extra: Partial<PartInstance> = {}): PartInstance {
  return {
    handle,
    doc_id: `doc-${handle}`,
    doc_rev: 1,
    transform: { ...IDENTITY_TRANSFORM },
    ...extra,
  }
}

describe('isManipulable', () => {
  it('rejects a fixed instance and a missing one', () => {
    expect(isManipulable(instance('p1'))).toBe(true)
    expect(isManipulable(instance('p1', { fixed: true }))).toBe(false)
    expect(isManipulable(undefined)).toBe(false)
  })
})

describe('beginManipulation', () => {
  it('seeds the session from the instance transform', () => {
    const doc = docWith(instance('p1', { transform: { ...IDENTITY_TRANSFORM, tx: 4 } }))
    const session = beginManipulation(doc, 'p1')!
    expect(session.handle).toBe('p1')
    expect(session.seed.tx).toBe(4)
    expect(session.current).toEqual(session.seed)
  })

  it('returns null for a fixed instance and for an unknown handle', () => {
    const doc = docWith(instance('p1', { fixed: true }))
    expect(beginManipulation(doc, 'p1')).toBeNull()
    expect(beginManipulation(doc, 'nope')).toBeNull()
  })
})

describe('drag translate', () => {
  it('measures the delta from the seed, so a replayed move does not accumulate drift', () => {
    const doc = docWith(instance('p1', { transform: { ...IDENTITY_TRANSFORM, tx: 1 } }))
    let session = beginManipulation(doc, 'p1')!
    session = dragTranslate(session, [2, 0, 0])
    session = dragTranslate(session, [2, 0, 0])  // same pointer position, resent
    expect(session.current.tx).toBe(3)
    expect(session.seed.tx).toBe(1)
  })

  it('drag-end writes the composed transform onto the instance', () => {
    const doc = docWith(instance('p1'), instance('p2'))
    const session = dragTranslate(beginManipulation(doc, 'p1')!, [1, 2, 3])
    const { doc: next, changed } = commitManipulation(doc, session)

    expect(changed).toBe(true)
    expect(findInstance(next, 'p1')!.transform).toMatchObject({ tx: 1, ty: 2, tz: 3 })
    // Untouched parts and the input doc are left alone (pure mutation).
    expect(findInstance(next, 'p2')!.transform).toEqual(IDENTITY_TRANSFORM)
    expect(findInstance(doc, 'p1')!.transform).toEqual(IDENTITY_TRANSFORM)
  })

  it('a drag that never left the seed pose commits nothing', () => {
    const doc = docWith(instance('p1'))
    const session = dragTranslate(beginManipulation(doc, 'p1')!, [0, 0, 0])
    const { doc: next, changed } = commitManipulation(doc, session)
    expect(changed).toBe(false)
    expect(next).toBe(doc)
  })
})

describe('gizmo rotate', () => {
  it('composes with the existing quaternion instead of replacing it', () => {
    const seed = makeTransform([0, 0, 0], quatFromAxisAngle([0, 0, 1], HALF_PI))
    const doc = docWith(instance('p1', { transform: seed }))
    const session = gizmoRotate(beginManipulation(doc, 'p1')!, [0, 0, 1], HALF_PI)
    const t = commitManipulation(doc, session).doc
    const q = findInstance(t, 'p1')!.transform
    // 90 + 90 about Z: the part's local +X ends at world -X.
    const x = rotateVector([q.qx, q.qy, q.qz, q.qw], [1, 0, 0])
    expect(x[0]).toBeCloseTo(-1, 9)
    expect(x[1]).toBeCloseTo(0, 9)
  })

  it('spins about the part origin when no pivot is given, keeping the translation put', () => {
    const doc = docWith(instance('p1', { transform: { ...IDENTITY_TRANSFORM, tx: 7 } }))
    const session = gizmoRotate(beginManipulation(doc, 'p1')!, [0, 0, 1], HALF_PI)
    expect(session.current.tx).toBeCloseTo(7, 9)
    expect(session.current.ty).toBeCloseTo(0, 9)
  })

  it('orbits the part when an external pivot is given', () => {
    const doc = docWith(instance('p1', { transform: { ...IDENTITY_TRANSFORM, tx: 1 } }))
    const session = gizmoRotate(beginManipulation(doc, 'p1')!, [0, 0, 1], HALF_PI, [0, 0, 0])
    expect(session.current.tx).toBeCloseTo(0, 9)
    expect(session.current.ty).toBeCloseTo(1, 9)
  })

  it('measures the angle from pointer-down, so a resent frame does not double-rotate', () => {
    const doc = docWith(instance('p1'))
    let session = beginManipulation(doc, 'p1')!
    session = gizmoRotate(session, [0, 0, 1], HALF_PI)
    session = gizmoRotate(session, [0, 0, 1], HALF_PI)
    const x = rotateVector(
      [session.current.qx, session.current.qy, session.current.qz, session.current.qw],
      [1, 0, 0],
    )
    expect(x[1]).toBeCloseTo(1, 9)  // +Y, i.e. a single 90-degree turn
  })
})

describe('livePartPose', () => {
  it('carries the drag delta onto the solved pose, not onto the doc seed', () => {
    const doc = docWith(instance('p1'))
    // A mate solved p1 to tx 10 while its doc seed stayed at the origin.
    const solved = { ...IDENTITY_TRANSFORM, tx: 10 }
    const session = dragTranslate(beginManipulation(doc, 'p1')!, [3, 0, 0])

    expect(livePartPose(session, solved).tx).toBeCloseTo(13, 9)
    expect(session.current.tx).toBeCloseTo(3, 9)  // the seed-relative preview, deliberately not the pose
  })

  it('translates a mate-rotated part without disturbing its solved orientation', () => {
    const doc = docWith(instance('p1'))
    const solved = makeTransform([0, 0, 0], quatFromAxisAngle([0, 0, 1], HALF_PI))
    const session = dragTranslate(beginManipulation(doc, 'p1')!, [0, 5, 0])
    const pose = livePartPose(session, solved)

    expect(pose.ty).toBeCloseTo(5, 9)
    const x = rotateVector([pose.qx, pose.qy, pose.qz, pose.qw], [1, 0, 0])
    expect(x[1]).toBeCloseTo(1, 9)  // still the solved 90-degree turn, no extra spin
  })

  it('falls back to the seed for a part no solve has posed yet', () => {
    const doc = docWith(instance('p1', { transform: { ...IDENTITY_TRANSFORM, tx: 2 } }))
    const session = dragTranslate(beginManipulation(doc, 'p1')!, [1, 0, 0])
    expect(livePartPose(session, undefined)).toMatchObject({ tx: 3 })
  })

  it('commits the live pose, so releasing a mate-pulled part does not teleport it back', () => {
    const doc = docWith(instance('p1'))
    const solved = { ...IDENTITY_TRANSFORM, tx: 10 }
    const session = dragTranslate(beginManipulation(doc, 'p1')!, [3, 0, 0])
    const { doc: next, changed } = commitManipulation(doc, session, solved)

    expect(changed).toBe(true)
    expect(findInstance(next, 'p1')!.transform).toMatchObject({ tx: 13 })
  })
})

describe('fixed instances are not manipulable by either path', () => {
  it('a part fixed mid-drag keeps its transform on commit', () => {
    const doc = docWith(instance('p1'))
    const dragged = dragTranslate(beginManipulation(doc, 'p1')!, [5, 5, 5])
    const spun = gizmoRotate(dragged, [0, 0, 1], HALF_PI)

    // The user fixes the part before releasing the pointer.
    const pinned = docWith(instance('p1', { fixed: true }))
    for (const session of [dragged, spun]) {
      const { doc: next, changed } = commitManipulation(pinned, session)
      expect(changed).toBe(false)
      expect(next).toBe(pinned)
      expect(findInstance(next, 'p1')!.transform).toEqual(IDENTITY_TRANSFORM)
    }
  })
})
