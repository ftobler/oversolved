// The pure face-projection reconcile: which boundary edge becomes which member,
// which ids survive an edit, and what a removed or vanished edge does. No OCC,
// no solver, no document store.

import { describe, it, expect, afterEach } from 'vitest'
import {
  boundaryFromFaceEdges,
  deriveMemberIds,
  edgeUuidToken,
  faceBoundaryFromBodies,
  faceProjectionConstraintId,
  freezeRowsForDelete,
  isFaceProjectionSource,
  reconcileFaceProjection,
  type FaceBoundary,
  type FaceBoundaryEdge,
} from '../projectionMembers'
import { applyAddProjectedEntity, applyDeleteElements, applyAddEntity } from '@/utils/yamlMutations/sketch'
import { setIdSource, mintEntityId } from '@/utils/yamlMutations/helpers'
import { seededIdSource } from '@/drive/seededIds'
import type { PartDoc } from '@/types/cad'

const CID = 'proj_face'

/** A wire-shaped edge query carrying one construction token. */
function edgeQuery(token: string, type = 'straightedge'): string {
  const framed = `@${token}`
  return `?${framed.length.toString(16)};${framed}:${type}`
}

function edge(token: string, kind = 'line'): FaceBoundaryEdge {
  return { token, query: edgeQuery(token), kind }
}

const TOKENS = [
  'u|e_11111111aaaaaaaaaaaaaaaaaaaaaaaa',
  'u|e_22222222bbbbbbbbbbbbbbbbbbbbbbbb',
  'u|e_33333333cccccccccccccccccccccccc',
]

function boundary(edges: FaceBoundaryEdge[], seams: string[] = []): FaceBoundary {
  return { edges, seams }
}

describe('edgeUuidToken', () => {
  it('reads the construction token without the wire at-sign', () => {
    expect(edgeUuidToken(edgeQuery(TOKENS[0]))).toBe(TOKENS[0])
  })

  it('answers null for a query with no construction UUID', () => {
    expect(edgeUuidToken('?2;@a:edge')).toBeNull()
    expect(edgeUuidToken('@sketch/e1')).toBeNull()
    expect(edgeUuidToken('not a query')).toBeNull()
  })
})

describe('face source predicates', () => {
  it('recognises every face restriction and nothing else', () => {
    for (const type of ['flatface', 'cylinderface', 'coneface', 'sphereface', 'torusface', 'face']) {
      expect(isFaceProjectionSource(edgeQuery('u|e_abcdef01', type))).toBe(true)
    }
    expect(isFaceProjectionSource(edgeQuery('u|e_abcdef01', 'edge'))).toBe(false)
    expect(isFaceProjectionSource(edgeQuery('u|e_abcdef01', 'vertex'))).toBe(false)
    expect(isFaceProjectionSource('@sketch/c1')).toBe(false)
  })

  it('derives a deterministic constraint id from the face UUID', () => {
    expect(faceProjectionConstraintId(edgeQuery('u|e_abcdef012345', 'flatface'))).toBe('proj_eabcdef0')
    expect(faceProjectionConstraintId('@sketch/c1')).toBeNull()
  })
})

describe('deriveMemberIds', () => {
  it('is stable across calls and orders', () => {
    const a = deriveMemberIds(CID, TOKENS)
    const b = deriveMemberIds(CID, [...TOKENS].reverse())
    expect(a).toEqual(b)
    expect(a[TOKENS[0]]).toBe(`${CID}.e1111111`)
  })

  it('lengthens the whole colliding group deterministically', () => {
    const left = 'u|e_abcdef01000000000000000000000000'
    const right = 'u|e_abcdef01ffffffffffffffffffffffff'
    const forward = deriveMemberIds(CID, [left, right])
    const reversed = deriveMemberIds(CID, [right, left])
    expect(Object.values(forward)).toHaveLength(2)
    expect(new Set(Object.values(forward)).size).toBe(2)
    expect(forward[left].startsWith(`${CID}.eabcdef01`)).toBe(true)
    expect(forward[left]).toBe(`${CID}.eabcdef01000`)
    expect(forward[right]).toBe(`${CID}.eabcdef01fff`)
    expect(reversed).toEqual(forward)
  })
})

describe('reconcileFaceProjection', () => {
  it('gives the same members for any walk order, ordered by token', () => {
    const forward = reconcileFaceProjection({ id: CID }, boundary(TOKENS.map(token => edge(token))))
    const reversed = reconcileFaceProjection({ id: CID }, boundary([...TOKENS].reverse().map(token => edge(token))))
    expect(forward.members).toEqual(reversed.members)
    expect(Object.keys(forward.members)).toEqual([...TOKENS].sort())
    expect(forward.added).toEqual([...TOKENS].sort())
  })

  it('never makes an excluded or seam edge a member', () => {
    const seam = edge(TOKENS[1])
    const result = reconcileFaceProjection(
      { id: CID, excluded: [TOKENS[2]] },
      boundary([edge(TOKENS[0]), seam, edge(TOKENS[2])], [seam.query]),
    )
    expect(Object.keys(result.members)).toEqual([TOKENS[0]])
    expect(result.members[TOKENS[1]]).toBeUndefined()
    expect(result.members[TOKENS[2]]).toBeUndefined()
  })

  it('pins a stored map unchanged when the face does not resolve', () => {
    const stored = deriveMemberIds(CID, TOKENS)
    const result = reconcileFaceProjection({ id: CID, members: stored }, null)
    expect(result.resolved).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.members).toBe(stored)
    expect(result.added).toEqual([])
  })

  it('derives no members from an empty boundary and nothing changed when the map is empty', () => {
    const result = reconcileFaceProjection({ id: CID }, boundary([]))
    expect(result.resolved).toBe(true)
    expect(result.members).toEqual({})
    expect(result.changed).toBe(false)
  })

  it('keeps the stored map object when the boundary is unchanged', () => {
    const stored = deriveMemberIds(CID, TOKENS)
    const result = reconcileFaceProjection({ id: CID, members: stored }, boundary(TOKENS.map(token => edge(token))))
    expect(result.members).toBe(stored)
    expect(result.changed).toBe(false)
    expect(result.kept).toEqual([...TOKENS].sort())
  })

  it('keeps an orphan in the map and reports it while a new edge is added', () => {
    const stored = deriveMemberIds(CID, [TOKENS[0], TOKENS[1]])
    const fresh = TOKENS[2]
    const result = reconcileFaceProjection(
      { id: CID, members: stored },
      boundary([edge(TOKENS[0]), edge(fresh)]),
    )
    expect(result.changed).toBe(true)
    expect(result.added).toEqual([fresh])
    expect(result.orphans).toEqual([TOKENS[1]])
    // The orphan keeps its old id, so the restored edge gets it back.
    expect(result.members[TOKENS[1]]).toBe(stored[TOKENS[1]])
    expect(result.members[fresh]).toBe(deriveMemberIds(CID, [TOKENS[0], fresh])[fresh])
  })

  it('keeps the map schema-valid when a new edge collides with an orphan', () => {
    const orphan = 'u|e_abcdef01aaaaaaaaaaaaaaaaaaaaaaaa'
    const fresh = 'u|e_abcdef01ffffffffffffffffffffffff'
    const stored = deriveMemberIds(CID, [orphan])
    const result = reconcileFaceProjection({ id: CID, members: stored }, boundary([edge(fresh)]))
    // The loader validates the whole map against one derivation, so both ids are
    // the deterministic lengthening over the whole key set.
    expect(result.members).toEqual(deriveMemberIds(CID, [orphan, fresh]))
    expect(new Set(Object.values(result.members)).size).toBe(2)
    expect(result.orphans).toEqual([orphan])
    expect(result.added).toEqual([fresh])
  })

  it('drops an excluded token from the map and re-adds it with the same id when restored', () => {
    const stored = deriveMemberIds(CID, TOKENS)
    const excluded = reconcileFaceProjection(
      { id: CID, members: stored, excluded: [TOKENS[1]] },
      boundary(TOKENS.map(token => edge(token))),
    )
    expect(excluded.members[TOKENS[1]]).toBeUndefined()
    expect(excluded.changed).toBe(true)
    const restored = reconcileFaceProjection(
      { id: CID, members: excluded.members },
      boundary(TOKENS.map(token => edge(token))),
    )
    expect(restored.members).toEqual(stored)
  })
})

describe('boundary adapters', () => {
  it('keeps only edges that carry a construction token', () => {
    const fromEdges = boundaryFromFaceEdges([
      { source: edgeQuery(TOKENS[0]), kind: 'line' },
      { source: '@sketch/e1', kind: 'line' },
    ])
    expect(fromEdges?.edges).toEqual([{ token: TOKENS[0], query: edgeQuery(TOKENS[0]), kind: 'line' }])
    expect(boundaryFromFaceEdges(null)).toBeNull()
  })

  it('finds a face by UUID when the stored query drifted', () => {
    const edgeQueryText = edgeQuery(TOKENS[0])
    const lookup = faceBoundaryFromBodies(() => ({
      b1: {
        mesh: {
          face_queries: ['?stale;drifted:flatface'],
          face_uuids: [TOKENS[0].slice(2)],
          face_edge_queries: [[edgeQueryText]],
          face_seam_queries: [[]],
        },
        edge_queries: [edgeQueryText],
        edges: [{ kind: 'line' }],
      },
    }))
    const source = edgeQuery(TOKENS[0], 'flatface')
    expect(lookup(source)?.edges).toEqual([{ token: TOKENS[0], query: edgeQueryText, kind: 'line' }])
  })
})

describe('freezeRowsForDelete', () => {
  const members = deriveMemberIds(CID, TOKENS)
  const feature = {
    constraints: [{ id: CID, kind: 'projection', members }],
  }
  const reports = {
    [CID]: {
      entities: TOKENS.map((token, index) => ({ id: members[token], kind: 'line', params: [0, 0, index, 1] })),
    },
  }

  it('reads the member rows a deleted face projection owned', () => {
    const rows = freezeRowsForDelete('sk1', feature, [`constraint:sk1:${CID}`], reports)
    expect(rows?.map(row => row.id)).toEqual(TOKENS.map(token => members[token]))
  })

  it('skips an excluded member and ignores ordinary targets', () => {
    const withExcluded = {
      constraints: [{ id: CID, kind: 'projection', members, excluded: [TOKENS[1]] }],
    }
    const rows = freezeRowsForDelete('sk1', withExcluded, [`constraint:sk1:${CID}`, 'entity:sk1:l1'], reports)
    expect(rows?.map(row => row.id)).not.toContain(members[TOKENS[1]])
    expect(rows).toHaveLength(2)
    expect(freezeRowsForDelete('sk1', feature, ['entity:sk1:l1'], reports)).toBeUndefined()
  })
})

describe('the add and delete appliers', () => {
  const faceSource = edgeQuery(TOKENS[0], 'flatface')

  afterEach(() => {
    setIdSource(null)
  })

  function sketchDoc(): PartDoc {
    return {
      version: 7, kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [], initial: {}, constraints: [],
      }],
    } as unknown as PartDoc
  }

  const boundary: FaceBoundary = { edges: TOKENS.map(token => edge(token)) }

  it('writes one face constraint with derived members and no entity row', () => {
    const doc = sketchDoc()
    const cid = faceProjectionConstraintId(faceSource)!
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
    })
    const sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    expect(sketch.entities).toEqual([])
    expect(sketch.constraints).toHaveLength(1)
    expect(sketch.constraints![0].id).toBe(cid)
    expect(sketch.constraints![0].target).toBeUndefined()
    expect(Object.keys(sketch.constraints![0].members ?? {})).toEqual([...TOKENS].sort())
    // A second pick of the same face is a duplicate, not a second constraint.
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
    })
    expect(sketch.constraints).toHaveLength(1)
  })

  it('draws a fresh constraint id past frozen member rows', () => {
    const doc = sketchDoc()
    const cid = faceProjectionConstraintId(faceSource)!
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
    })
    const sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    const frozen = Object.values(sketch.constraints![0].members!)
    applyDeleteElements(
      doc,
      [`constraint:sk1:${cid}`],
      frozen.map(id => ({ id, kind: 'line', params: [0, 0, 1, 1] })),
    )
    expect(sketch.entities?.map(e => e.id).sort()).toEqual([...frozen].sort())
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
    })
    const fresh = sketch.constraints?.find(c => c.kind === 'projection')
    expect(fresh?.id).toBe(`${cid}_2`)
    // The frozen ids are never reused, so the two entity families cannot merge.
    expect(Object.values(fresh?.members ?? {}).some(id => frozen.includes(id))).toBe(false)
  })

  it('refuses a face add with no solved boundary', () => {
    const doc = sketchDoc()
    applyAddProjectedEntity(doc, 'sk1', '', faceSource)
    const sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    expect(sketch.constraints).toEqual([])
  })

  it('writes excluded tokens and refuses a supplied map the loader would refuse', () => {
    const doc = sketchDoc()
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
      excluded: [TOKENS[1], TOKENS[1]],
    })
    let sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    expect(sketch.constraints![0].excluded).toEqual([TOKENS[1]])

    const other = sketchDoc()
    applyAddProjectedEntity(other, 'sk1', '', faceSource, undefined, undefined, {
      members: { [TOKENS[0]]: 'proj_face.wrong' },
    })
    sketch = (other.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    expect(sketch.constraints).toEqual([])

    // With a boundary the bad map is ignored and the real one derived.
    applyAddProjectedEntity(other, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
      members: { [TOKENS[0]]: 'proj_face.wrong' },
    })
    expect(Object.keys(sketch.constraints?.[0].members ?? {})).toEqual([...TOKENS].sort())
  })

  it('refuses a face with no boundary edge instead of storing an empty map', () => {
    const doc = sketchDoc()
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => ({ edges: [] }),
    })
    const sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    expect(sketch.constraints).toEqual([])
  })

  it('consumes no mint, so a later add_entity gets the source first id', () => {
    const seed = 12345
    const control = seededIdSource(seed)
    setIdSource(control)
    const expected = mintEntityId([], undefined)

    const run = seededIdSource(seed)
    setIdSource(run)
    const doc = sketchDoc()
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
    })
    applyAddEntity(doc, 'sk1', 'point', [8, 8])
    const sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    expect(sketch.entities?.map(entity => entity.id)).toEqual([expected])
  })

  it('records a member delete as an exclusion and leaves the constraint', () => {
    const doc = sketchDoc()
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
    })
    const sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    const token = TOKENS[0]
    const member = sketch.constraints![0].members![token]
    applyDeleteElements(doc, [`entity:sk1:${member}`])
    expect(sketch.constraints![0].excluded).toEqual([token])
    expect(sketch.constraints).toHaveLength(1)
  })

  it('does not freeze a member deleted in the same press as its projection', () => {
    const doc = sketchDoc()
    applyAddProjectedEntity(doc, 'sk1', '', faceSource, undefined, undefined, {
      faceBoundary: () => boundary,
    })
    const sketch = (doc.features ?? [])[0]
    if (sketch.kind !== 'sketch') throw new Error('not a sketch')
    const cid = sketch.constraints![0].id
    const first = sketch.constraints![0].members![TOKENS[0]]
    const second = sketch.constraints![0].members![TOKENS[1]]
    applyDeleteElements(
      doc,
      [`entity:sk1:${first}`, `constraint:sk1:${cid}`],
      [
        { id: first, kind: 'line', params: [0, 0, 1, 1] },
        { id: second, kind: 'line', params: [1, 0, 2, 1] },
      ],
    )
    expect(sketch.constraints).toEqual([])
    expect(sketch.entities?.map(entity => entity.id)).toEqual([second])
    expect(sketch.initial?.[first]).toBeUndefined()
  })
})
