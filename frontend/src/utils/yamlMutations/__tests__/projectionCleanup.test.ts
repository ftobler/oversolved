// The cleanup command removes projections the solve flagged. A live face
// projection is flagged while its face is transiently unresolved, but removing
// it would delete the constraint and its wire for good; only the user's explicit
// delete freezes it. A single-edge projection stays eligible.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyRemoveDanglingContent, hasDanglingContentInDoc } from '../solveResult'

const FACE = 'proj_face'
const EDGE = 'proj_edge'
const EMPTY = 'proj_empty'

function doc(): PartDoc {
  return {
    version: 7,
    kind: 'part',
    features: [{
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'p1', kind: 'point' }],
      initial: { p1: [0, 0] },
      constraints: [
        { id: FACE, kind: 'projection', source: '?face', members: { 'u|e_aaaa': 'proj_face.aaaaaaaa' } },
        { id: EDGE, kind: 'projection', target: '$p1', source: '?edge;line' },
        { id: EMPTY, kind: 'projection', source: '?face;flatface' },
      ],
    }],
  } as unknown as PartDoc
}

function constraints(d: PartDoc): string[] {
  const feature = d.features?.[0]
  if (feature?.kind !== 'sketch') throw new Error('no sketch')
  return (feature.constraints ?? []).map(c => c.id)
}

describe('cleanup and a live face projection', () => {
  it('keeps a targetless projection that carries a member map', () => {
    const d = doc()
    applyRemoveDanglingContent(d, { sk1: { projections: [FACE, EDGE, EMPTY], constraints: [] } })
    expect(constraints(d)).toEqual([FACE])
  })

  it('does not report the kept face projection as removable', () => {
    expect(hasDanglingContentInDoc(doc(), { sk1: { projections: [FACE], constraints: [] } })).toBe(false)
    expect(hasDanglingContentInDoc(doc(), { sk1: { projections: [EDGE], constraints: [] } })).toBe(true)
    expect(hasDanglingContentInDoc(doc(), { sk1: { projections: [EMPTY], constraints: [] } })).toBe(true)
  })
})
