import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyAddConstraint, applySetConstraintSign } from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const constraints0 = (doc: PartDoc) => featureAt(doc, 0, 'sketch').constraints!

const makeDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    {
      id: 'S1',
      kind: 'sketch',
      initial: { pa: [0, 0], pb: [10, 5] },
      entities: [
        { id: 'pa', kind: 'point' },
        { id: 'pb', kind: 'point' },
      ],
      constraints: [],
    },
  ],
})

const onlyConstraint = (doc: PartDoc) => constraints0(doc)[0]

describe('applyAddConstraint with sign', () => {
  it('writes the orientation sign onto a directional dimension', () => {
    const doc = makeDoc()
    applyAddConstraint(doc, 'S1', 'point_distance_x', ['vertex:S1:pa', 'vertex:S1:pb'], 10, undefined, -1)
    expect(onlyConstraint(doc).sign).toBe(-1)
    expect(onlyConstraint(doc).value).toBe(10)
  })

  it('omits sign when none is given (legacy side-agnostic dim)', () => {
    const doc = makeDoc()
    applyAddConstraint(doc, 'S1', 'point_distance', ['vertex:S1:pa', 'vertex:S1:pb'], 11)
    expect(onlyConstraint(doc).sign).toBeUndefined()
  })
})

describe('applySetConstraintSign', () => {
  it('flips +1 to -1 and back, normalizing to unit magnitude', () => {
    const doc = makeDoc()
    applyAddConstraint(doc, 'S1', 'point_distance_x', ['vertex:S1:pa', 'vertex:S1:pb'], 10, undefined, 1)
    const cid = onlyConstraint(doc).id

    applySetConstraintSign(doc, 'S1', cid, -1)
    expect(onlyConstraint(doc).sign).toBe(-1)

    applySetConstraintSign(doc, 'S1', cid, 1)
    expect(onlyConstraint(doc).sign).toBe(1)

    // Any positive/negative magnitude collapses to +1/-1.
    applySetConstraintSign(doc, 'S1', cid, -7)
    expect(onlyConstraint(doc).sign).toBe(-1)
  })

  it('is a no-op for an unknown constraint id', () => {
    const doc = makeDoc()
    applyAddConstraint(doc, 'S1', 'point_distance_x', ['vertex:S1:pa', 'vertex:S1:pb'], 10, undefined, 1)
    applySetConstraintSign(doc, 'S1', 'does_not_exist', -1)
    expect(onlyConstraint(doc).sign).toBe(1)
  })
})
