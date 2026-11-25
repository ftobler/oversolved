// @vitest-environment node
//
// The authoring probe's seam: Part.tsx holds the last solve, so it supplies the
// resolved kinds and the derived face members and the probe must forward both.
// Without the map a projected entity whose resolution changed its kind is read
// in the stale document kind. Part.tsx passes an empty render map when no solve
// has landed; that is the honest answer, and the document kind is used.
//
// The real solver is mocked: this test is about the forwarding, not the answer,
// and the answer itself is pinned against the real kernel in sketchRedundancy.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const probe = vi.hoisted(() =>
  vi.fn<(feature: unknown, draftId: string, kinds?: unknown, members?: unknown) => boolean>(() => false))
vi.mock('../sketch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sketch')>()
  return { ...actual, probeRedundantConstraint: probe }
})

import { classifyPendingAdd, decideUnDrive } from '../constraintProbe'
import type { PartDoc } from '@/types/cad'

function doc(): PartDoc {
  return {
    version: 7,
    kind: 'part',
    features: [{
      id: 'sk1', kind: 'sketch', label: 'Sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [],
    }],
  } as unknown as PartDoc
}

/** S1 already holds the projection of S2's line L9 and a coincident against it,
 *  so a second pick of the same foreign line is a duplicate the stored-target
 *  check cannot see until the applier resolves the projection. */
function crossSketchDoc(): PartDoc {
  return {
    version: 7,
    kind: 'part',
    features: [
      {
        id: 'S2', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'L9', kind: 'line' }],
        initial: { L9: [0, 0, 5, 5] },
        constraints: [],
      },
      {
        id: 'S1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'l1', kind: 'line' }, { id: 'p9', kind: 'line' }],
        initial: { l1: [0, 0, 10, 0], p9: [0, 0, 5, 5] },
        constraints: [
          { id: 'proj_L9', kind: 'projection', target: '$p9', source: '@S2/L9' },
          { id: 'c_dup', kind: 'coincident', a: '$l1start', b: '$p9' },
        ],
      },
    ],
  } as unknown as PartDoc
}

const pending = { featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 10 }

describe('classifyPendingAdd projection facts', () => {
  beforeEach(() => probe.mockClear())

  it('forwards the last solve resolved kinds and derived members', () => {
    const resolvedKinds = { pc: 'line' }
    const derivedMembers = [{ id: 'proj_face.aaaaaaaa', kind: 'line', params: [0, 0, 1, 0] }]
    expect(classifyPendingAdd(doc(), pending, resolvedKinds, derivedMembers)).toBe('ok')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][2]).toBe(resolvedKinds)
    expect(probe.mock.calls[0][3]).toBe(derivedMembers)
  })

  it('forwards the empty render map when no solve has landed, so the document kind is honest', () => {
    const empty = {}
    expect(classifyPendingAdd(doc(), pending, empty)).toBe('ok')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][2]).toBe(empty)
  })

  it('answers redundant for an exact duplicate without asking the solver', () => {
    const duplicate = doc()
    const feature = duplicate.features![0]
    if (feature.kind !== 'sketch') throw new Error('fixture is not a sketch')
    feature.constraints = [{ id: 'c_same', kind: 'length', target: '$l1', value: 10 }]
    expect(classifyPendingAdd(duplicate, pending)).toBe('redundant')
    expect(probe).not.toHaveBeenCalled()
  })

  it('answers redundant when a cross-sketch pick only duplicates after projection', () => {
    const repeat = {
      featureId: 'S1',
      kind: 'coincident',
      targets: ['vertex:S1:l1:start', 'entity:S2:L9'],
    }
    expect(classifyPendingAdd(crossSketchDoc(), repeat)).toBe('redundant')
    expect(probe).not.toHaveBeenCalled()
  })
})

/** A driven length on a face projection's derived member. The member is a
 *  solve-time row, not a document entity, so the un-drive probe can only see the
 *  dimension when the caller passes the last solve's derived members. */
function projectedDoc(): PartDoc {
  return {
    version: 7,
    kind: 'part',
    features: [{
      id: 'sk1', kind: 'sketch', label: 'Sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [
        { id: 'proj_face', kind: 'projection', source: '?face', members: { 'u|e_aaaa': 'proj_face.aaaaaaaa' } },
        { id: 'c_ref', kind: 'length', target: '$proj_face.aaaaaaaa', value: 1, driven: true },
      ],
    }],
  } as unknown as PartDoc
}

const derivedMembers = [{ id: 'proj_face.aaaaaaaa', kind: 'line', params: [0, 0, 1, 0] }]

describe('decideUnDrive on projected geometry', () => {
  beforeEach(() => {
    probe.mockClear()
    // The real solver can only flag the row when the derived member rows are
    // present in the lowered copy; model that instead of a blanket `true`.
    probe.mockImplementation((_feature, _id, _kinds, members) =>
      Array.isArray(members) && members.length > 0)
  })

  it('forwards the solve members so a redundant un-drive is refused', () => {
    const decision = decideUnDrive(projectedDoc(), 'sk1', 'c_ref', {}, derivedMembers)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/would overconstrain the sketch/)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][3]).toBe(derivedMembers)
  })

  it('would allow it without the solve members: the draft drops as unresolved', () => {
    // The regression the page fix closes: Part.tsx must supply the rows from
    // projection_members, or this gate reads "dropped" and lets the row drive.
    expect(decideUnDrive(projectedDoc(), 'sk1', 'c_ref', {}).allowed).toBe(true)
    // The probe still runs, but with no derived member rows it has no basis to
    // call the driving row redundant. That is the answer allowing the un-drive.
    expect(probe.mock.calls[0][3]).toBeUndefined()
  })
})
