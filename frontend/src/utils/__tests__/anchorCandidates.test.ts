// Stage 7's pick contract, exercised with synthetic hits: no ID buffer, no
// canvas, no store. A hit list in, a candidate set out.

import { describe, it, expect } from 'vitest'
import {
  assemblyBuiltinEntityKey,
  assemblyEntityKey,
  cycleIndex,
  resolveCandidates,
  type EntityMateRefs,
} from '@/utils/anchorCandidates'
import { ASSEMBLY_HANDLE, ASSEMBLY_TOP_ID } from '@/utils/assemblyBuiltins'

const PART = 'inst_a1'

// A corner of `PART`: three faces, three edges, one vertex, each with one anchor.
const CORNER_FACE = [0, 1, 2].map(i => assemblyEntityKey(PART, 0, 'face', i))
const CORNER_EDGE = [0, 1, 2].map(i => assemblyEntityKey(PART, 0, 'edge', i))
const CORNER_VERT = assemblyEntityKey(PART, 0, 'vertex', 0)
/** An extrude over a spline profile: picked, but carrying no anchor. */
const FREEFORM_FACE = assemblyEntityKey(PART, 0, 'face', 9)

const REFS: EntityMateRefs = {
  [CORNER_VERT]: [{ part: PART, anchor: 'a_v0' }],
  [CORNER_EDGE[0]]: [{ part: PART, anchor: 'a_e0' }],
  [CORNER_EDGE[1]]: [{ part: PART, anchor: 'a_e1' }],
  [CORNER_EDGE[2]]: [{ part: PART, anchor: 'a_e2' }],
  [CORNER_FACE[0]]: [{ part: PART, anchor: 'a_f0' }],
  [CORNER_FACE[1]]: [{ part: PART, anchor: 'a_f1' }],
  [CORNER_FACE[2]]: [{ part: PART, anchor: 'a_f2' }],
  [FREEFORM_FACE]: [],
  [assemblyBuiltinEntityKey(ASSEMBLY_TOP_ID)]: [{ part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID }],
}

/** Hits arrive resolver-ordered: vertex, then edges, then faces. */
const CORNER_HITS = [
  { entityKey: CORNER_VERT },
  ...CORNER_EDGE.map(entityKey => ({ entityKey })),
  ...CORNER_FACE.map(entityKey => ({ entityKey })),
]

describe('resolveCandidates', () => {
  it('a corner hit resolves to more than one candidate mate ref', () => {
    const cands = resolveCandidates(CORNER_HITS, REFS)
    expect(cands).toHaveLength(7)
    expect(cands[0]).toEqual({ part: PART, anchor: 'a_v0' })
  })

  it('preserves resolver order, so the first candidate is the singleton pick', () => {
    const cands = resolveCandidates(CORNER_HITS, REFS)
    expect(cands.map(c => c.anchor)).toEqual([
      'a_v0', 'a_e0', 'a_e1', 'a_e2', 'a_f0', 'a_f1', 'a_f2',
    ])
  })

  it('a non-corner hit resolves to exactly one candidate', () => {
    expect(resolveCandidates([{ entityKey: CORNER_FACE[0] }], REFS)).toEqual([
      { part: PART, anchor: 'a_f0' },
    ])
  })

  it('a hit on an anchor-less freeform entity resolves to an empty set', () => {
    expect(resolveCandidates([{ entityKey: FREEFORM_FACE }], REFS)).toEqual([])
  })

  it('an unknown entity key contributes nothing rather than throwing', () => {
    expect(resolveCandidates([{ entityKey: 'who|0|face|3' }], REFS)).toEqual([])
  })

  it('an entity offering several anchors yields several candidates', () => {
    const refs: EntityMateRefs = {
      [CORNER_VERT]: [
        { part: PART, anchor: 'a_v0' },
        { part: PART, anchor: 'a_v0_alt' },
      ],
    }
    expect(resolveCandidates([{ entityKey: CORNER_VERT }], refs)).toHaveLength(2)
  })

  it('dedupes a mate ref two hit entities both name', () => {
    const shared = { part: PART, anchor: 'a_shared' }
    const refs: EntityMateRefs = {
      [CORNER_EDGE[0]]: [shared],
      [CORNER_EDGE[1]]: [{ ...shared }],  // same (part, anchor), different object
    }
    const cands = resolveCandidates(
      [{ entityKey: CORNER_EDGE[0] }, { entityKey: CORNER_EDGE[1] }], refs,
    )
    expect(cands).toEqual([shared])
  })

  it('the entity scope filter narrows the set to the hovered entity only', () => {
    const cands = resolveCandidates(CORNER_HITS, REFS, CORNER_FACE[1])
    expect(cands).toEqual([{ part: PART, anchor: 'a_f1' }])
  })

  it('scoping to an entity the cursor does not cover yields nothing', () => {
    expect(resolveCandidates(CORNER_HITS, REFS, FREEFORM_FACE)).toEqual([])
  })

  it('resolves an assembly built-in plane to the reserved assembly handle', () => {
    const cands = resolveCandidates([{ entityKey: assemblyBuiltinEntityKey(ASSEMBLY_TOP_ID) }], REFS)
    expect(cands).toEqual([{ part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID }])
  })
})

describe('assemblyEntityKey', () => {
  it('separates two instances of the same part', () => {
    expect(assemblyEntityKey('h1', 0, 'face', 3)).not.toBe(assemblyEntityKey('h2', 0, 'face', 3))
  })

  it('separates kinds sharing an index', () => {
    expect(assemblyEntityKey('h1', 0, 'face', 3)).not.toBe(assemblyEntityKey('h1', 0, 'edge', 3))
  })

  it('separates bodies of one part', () => {
    expect(assemblyEntityKey('h1', 0, 'face', 3)).not.toBe(assemblyEntityKey('h1', 1, 'face', 3))
  })
})

describe('cycleIndex', () => {
  it('advances and wraps', () => {
    expect(cycleIndex(3, 0)).toBe(1)
    expect(cycleIndex(3, 1)).toBe(2)
    expect(cycleIndex(3, 2)).toBe(0)
  })

  it('stays at -1 on an empty set', () => {
    expect(cycleIndex(0, -1)).toBe(-1)
  })

  it('lands on the only candidate of a single-element set', () => {
    expect(cycleIndex(1, 0)).toBe(0)
  })
})
