// The document boundary's Group member rule: a group holds whole authored
// entities and single points of its own sketch. An unknown member, a point the
// entity's kind does not carry, a whole-plus-point duplicate, a lone point and a
// projected member are refused by field instead of lowering a row that cannot
// solve (the solver would drop it, or fight the projection's pin).
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function doc(group: Record<string, unknown>) {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk',
      kind: 'sketch',
      entities: [{ id: 'l1', kind: 'line' }, { id: 'c1', kind: 'circle' }, { id: 'p1', kind: 'point' }],
      initial: { l1: [0, 0, 4, 0], c1: [6, 0, 1], p1: [9, 9] },
      constraints: [group],
    }],
  }
}

const flat = (r: ReturnType<typeof loadPartDoc>) => r.ok ? null : `${r.error.field}: ${r.error.message}`

describe('group members at the document boundary', () => {
  it('loads a group over whole authored entities', () => {
    expect(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$l1', '$c1'] })).ok).toBe(true)
  })

  it('refuses an unknown member', () => {
    const error = flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$l1', '$gone'] })))
    expect(error).toContain('refs[1]')
    expect(error).toContain('names no entity')
  })

  it('loads point members beside whole members', () => {
    expect(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$l1', '$c1center'] })).ok).toBe(true)
  })

  it('refuses the dict member form no walker reads', () => {
    const error = flat(loadPartDoc(doc({
      id: 'g1', kind: 'group', refs: [{ entity: 'c1', point: 'center' }, '$l1'],
    })))
    expect(error).toContain('refs[0]')
    expect(error).toContain('must name an authored entity or point')
  })

  it('loads a lone point entity picked by its xy', () => {
    expect(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$p1xy'] })).ok).toBe(true)
  })

  it('refuses a Point named both whole and by its xy', () => {
    for (const refs of [['$p1xy', '$p1'], ['$p1', '$p1xy']]) {
      const error = flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs })))
      expect(error).toContain('both whole and by point')
    }
  })

  it('refuses a point key the entity kind does not carry', () => {
    const error = flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$l1c1', '$c1'] })))
    expect(error).toContain('names point')
    expect(error).toContain('not a point of line')
    // A Point has only `xy`; a hand-built `center` is the helper's pass-through
    // that this rule owns.
    expect(flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$p1center', '$l1'] }))))
      .toContain('not a point of point')
  })

  it('refuses a lone point member', () => {
    const error = flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$l1start'] })))
    expect(error).toContain('at least two points, or one whole entity')
  })

  it('refuses an entity named both whole and by point', () => {
    const error = flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$l1', '$l1start'] })))
    expect(error).toContain('both whole and by point')
  })

  it('refuses a projected member', () => {
    const raw = doc({ id: 'g1', kind: 'group', refs: ['$l1', '$p1'] })
    const feature = raw.features[0] as { constraints: unknown[] }
    feature.constraints.push({ id: 'proj', kind: 'projection', target: '$p1', source: '@edge1' })
    const error = flat(loadPartDoc(raw))
    expect(error).toContain('projected entity')
  })

  it('refuses an empty member list', () => {
    const error = flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: [] })))
    expect(error).toContain('at least one member')
  })
})
