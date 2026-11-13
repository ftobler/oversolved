// The projection member map is a derived identity, so the loader proves each
// stored id equals the form the solve would derive. The change is additive:
// a v7 document either carries the map or does not, and no migration rewrites
// it, so the ladder version does not move.

import { describe, it, expect } from 'vitest'
import { CURRENT_DOC_VERSION, loadPartDoc } from '@/persistence/docSchema'
import { deriveMemberIds } from '@/kernel/features/projectionMembers'

const TOKEN = 'u|e_1234567890abcdef1234567890abcdef'
const SECOND = 'u|e_fedcba0987654321fedcba0987654321'

function queryOf(token: string, type: string): string {
  const framed = `@${token}`
  return `?${framed.length.toString(16)};${framed}:${type}`
}

const FACE = queryOf(TOKEN, 'flatface')
const EDGE = queryOf(SECOND, 'straightedge')
const CID = 'proj_face'

function doc(constraint: Record<string, unknown>): Record<string, unknown> {
  return {
    version: CURRENT_DOC_VERSION,
    kind: 'part',
    features: [{
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {}, constraints: [constraint],
    }],
  }
}

describe('projection member validation', () => {
  it('accepts the derived map and keeps it at the current version', () => {
    const members = deriveMemberIds(CID, [TOKEN])
    const result = loadPartDoc(doc({ id: CID, kind: 'projection', source: FACE, members }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toEqual([])
    expect(result.doc.version).toBe(CURRENT_DOC_VERSION)
    const sketch = result.doc.features?.[0]
    expect(sketch?.kind).toBe('sketch')
    if (sketch?.kind !== 'sketch') return
    expect(sketch.constraints?.[0].members).toEqual(members)
  })

  it('refuses a member id that is not the derived form, by field', () => {
    const result = loadPartDoc(doc({
      id: CID, kind: 'projection', source: FACE, members: { [TOKEN]: 'proj_face.wrong' },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe(`features[0].constraints[0].members[${JSON.stringify(TOKEN)}]`)
    expect(result.error.message).toContain('must be')
  })

  it('loads the legacy held-centroid face projection (target plus point entity)', () => {
    // The shape the previous build wrote for a face pick with no boundary, and
    // for a drive face source with kind point: one held point entity, a target,
    // and a face query as the source. It is accepted as-is, with no migration.
    const legacy = {
      version: CURRENT_DOC_VERSION,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'c0', kind: 'point' }],
        initial: { c0: [0, 0] },
        constraints: [{ id: 'proj_c0', kind: 'projection', target: '$c0', source: FACE }],
      }],
    }
    const result = loadPartDoc(legacy)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toEqual([])
    const sketch = result.doc.features?.[0]
    if (sketch?.kind !== 'sketch') throw new Error('not a sketch')
    expect(sketch.constraints?.[0]).toMatchObject({ target: '$c0', source: FACE })
    expect(sketch.constraints?.[0].members).toBeUndefined()
  })

  it('refuses a derived member map on the legacy target form', () => {
    const members = deriveMemberIds('proj_c0', [TOKEN])
    const result = loadPartDoc(doc({
      id: 'proj_c0', kind: 'projection', target: '$p1', source: FACE, members,
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('features[0].constraints[0].members')
  })

  it('requires a target on an edge projection', () => {
    const edgeNoTarget = loadPartDoc(doc({ id: 'proj_e', kind: 'projection', source: EDGE }))
    expect(edgeNoTarget.ok).toBe(false)
    if (!edgeNoTarget.ok) expect(edgeNoTarget.error.field).toBe('features[0].constraints[0].target')
  })

  it('accepts excluded tokens and refuses a malformed one', () => {
    const members = deriveMemberIds(CID, [TOKEN])
    const ok = loadPartDoc(doc({
      id: CID, kind: 'projection', source: FACE, members, excluded: [TOKEN],
    }))
    expect(ok.ok).toBe(true)
    const bad = loadPartDoc(doc({
      id: CID, kind: 'projection', source: FACE, members, excluded: ['@u|nope'],
    }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.field).toBe('features[0].constraints[0].excluded[0]')
  })

  it('refuses members on a non-projection constraint', () => {
    const result = loadPartDoc(doc({
      id: 'c1', kind: 'horizontal', target: '$l1', members: { [TOKEN]: 'x' },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('features[0].constraints[0].members')
  })
})
