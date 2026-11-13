// The document boundary's Group member rule: a group holds whole authored
// entities of its own sketch. An unknown member, a vertex suffix and a
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

  it('refuses a vertex suffix', () => {
    const error = flat(loadPartDoc(doc({ id: 'g1', kind: 'group', refs: ['$l1start'] })))
    expect(error).toContain('names no entity')
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
