import { describe, it, expect } from 'vitest'
import type { PartConstraint, PartEntityDef } from '@/types/cad'
import { tangentFoot, dockLocationOf, dockHostsOf } from '@/utils/geometry/dockHosts'

describe('tangentFoot', () => {
  it('circle/circle external tangency: contact on the centre line at radius A', () => {
    // A: centre (0,0) r5, B: centre (10,0) r5 -> touch at (5,0).
    const at = tangentFoot({ kind: 'circle', p: [0, 0, 5] }, { kind: 'circle', p: [10, 0, 5] })
    expect(at).not.toBeNull()
    expect(at![0]).toBeCloseTo(5, 9)
    expect(at![1]).toBeCloseTo(0, 9)
  })

  it('circle/circle internal tangency: contact on big circle toward small centre', () => {
    // A: centre (0,0) r5, B: centre (3,0) r2, internally tangent -> (5,0).
    const at = tangentFoot({ kind: 'circle', p: [0, 0, 5] }, { kind: 'circle', p: [3, 0, 2] })
    expect(at![0]).toBeCloseTo(5, 9)
    expect(at![1]).toBeCloseTo(0, 9)
  })

  it('line/circle: contact is the foot of perpendicular from the centre', () => {
    // Horizontal line y=0 (through (-5,0)-(5,0)); circle centre (2,3) r3 tangent
    // to it -> contact at (2,0).
    const at = tangentFoot({ kind: 'line', p: [-5, 0, 5, 0] }, { kind: 'circle', p: [2, 3, 3] })
    expect(at![0]).toBeCloseTo(2, 9)
    expect(at![1]).toBeCloseTo(0, 9)
  })

  it('arc behaves like a circle (centre + radius)', () => {
    const at = tangentFoot({ kind: 'arc', p: [0, 0, 5, 0, 3.14] }, { kind: 'circle', p: [10, 0, 5] })
    expect(at![0]).toBeCloseTo(5, 9)
  })

  it('returns null for line/line (no contact point)', () => {
    expect(tangentFoot({ kind: 'line', p: [0, 0, 1, 0] }, { kind: 'line', p: [0, 0, 0, 1] })).toBeNull()
  })
})

const entities: PartEntityDef[] = [
  { id: 'circA', kind: 'circle' },
  { id: 'circB', kind: 'circle' },
]
const params = { circA: [0, 0, 5], circB: [10, 0, 5] }

describe('dockLocationOf', () => {
  it('computes a tangent host foot by id', () => {
    const cons: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' }]
    const at = dockLocationOf(entities, cons, params, 'tan')
    expect(at![0]).toBeCloseTo(5, 9)
  })

  it('returns null for a non-tangent or missing host', () => {
    const cons: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' }]
    expect(dockLocationOf(entities, cons, params, 'nope')).toBeNull()
  })
})

describe('dockHostsOf', () => {
  it('enumerates each dockable tangent host with its contact location', () => {
    const cons: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' }]
    const hosts = dockHostsOf(entities, cons, params)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toMatchObject({ hostId: 'tan', hostKind: 'tangent' })
    expect(hosts[0].at[0]).toBeCloseTo(5, 9)
  })

  it('omits a host that is already materialized (a dock names it)', () => {
    const cons: PartConstraint[] = [
      { id: 'tan', kind: 'tangent', a: '$circA', b: '$circB' },
      { id: 'dk', kind: 'dock', point: '$ptxy', host: 'tan' },
    ]
    expect(dockHostsOf(entities, cons, params)).toHaveLength(0)
  })

  it('skips a tangent whose operands are not resolvable curves', () => {
    const cons: PartConstraint[] = [{ id: 'tan', kind: 'tangent', a: '$gone', b: '$circB' }]
    expect(dockHostsOf(entities, cons, params)).toHaveLength(0)
  })
})
