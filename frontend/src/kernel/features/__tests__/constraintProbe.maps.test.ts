// @vitest-environment node
//
// The authoring probe's seam: Part.tsx holds the last solve, so it supplies the
// resolved kinds and the derived face members and the probe must forward both.
// Without the map a projected entity whose resolution changed its kind is read
// in the stale document kind. A caller with no last solve passes nothing, and
// the document kind is then the honest answer.
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

import { classifyPendingAdd, wouldOverconstrain } from '../constraintProbe'
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

  it('passes nothing when the caller has no last solve, so the document kind is honest', () => {
    expect(classifyPendingAdd(doc(), pending)).toBe('ok')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][2]).toBeUndefined()
    expect(probe.mock.calls[0][3]).toBeUndefined()
  })

  it('forwards the same facts through the wouldOverconstrain wrapper', () => {
    const resolvedKinds = { pc: 'line' }
    const derivedMembers = [{ id: 'proj_face.aaaaaaaa', kind: 'line', params: [0, 0, 1, 0] }]
    expect(wouldOverconstrain(doc(), pending, resolvedKinds, derivedMembers)).toBe(false)
    expect(probe.mock.calls[0][2]).toBe(resolvedKinds)
    expect(probe.mock.calls[0][3]).toBe(derivedMembers)
  })
})
