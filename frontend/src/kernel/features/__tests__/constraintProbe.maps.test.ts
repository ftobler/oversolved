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

import { classifyPendingAdd } from '../constraintProbe'
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

  it('forwards the empty render map when no solve has landed, so the document kind is honest', () => {
    const empty = {}
    expect(classifyPendingAdd(doc(), pending, empty)).toBe('ok')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][2]).toBe(empty)
  })
})
