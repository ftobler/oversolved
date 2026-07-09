// Stage 7 in the store: a pick keeps its whole candidate set and aims one of
// them. Ctrl+click cycles the aim; Ctrl+hover narrows the set to one entity.
// No viewport, no ID buffer: the hits are synthetic.

import { describe, it, expect, beforeEach } from 'vitest'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { assemblyEntityKey, type EntityMateRefs } from '@/utils/anchorCandidates'

const PART = 'h1'
const VERT = assemblyEntityKey(PART, 0, 'vertex', 0)
const EDGE = assemblyEntityKey(PART, 0, 'edge', 0)
const FACE = assemblyEntityKey(PART, 0, 'face', 0)
const FREEFORM = assemblyEntityKey(PART, 0, 'face', 1)

const ENTITY_MATE_REFS: EntityMateRefs = {
  [VERT]: [{ part: PART, anchor: 'a_v' }],
  [EDGE]: [{ part: PART, anchor: 'a_e' }],
  [FACE]: [{ part: PART, anchor: 'a_f' }],
  [FREEFORM]: [],
}

/** Resolver order at a corner: vertex wins, then the edge, then the face. */
const CORNER_HITS = [{ entityKey: VERT }, { entityKey: EDGE }, { entityKey: FACE }]

const { getState } = useAssemblyStore

beforeEach(() => {
  getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  getState().clearPickCandidates()
  getState().setPickScopeEntity(null)
  getState().setSolveResult({}, {}, {}, ENTITY_MATE_REFS)
})

describe('assemblyStore pick candidates', () => {
  it('a corner hit stores every candidate and aims the first', () => {
    getState().setPickFromHits(CORNER_HITS)
    expect(getState().pickCandidates.map(c => c.anchor)).toEqual(['a_v', 'a_e', 'a_f'])
    expect(getState().pickIndex).toBe(0)
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_v' })
  })

  it('cycling advances through the set in turn and wraps', () => {
    getState().setPickFromHits(CORNER_HITS)
    const seen = []
    for (let i = 0; i < 4; i++) {
      seen.push(getState().activePickCandidate()!.anchor)
      getState().cyclePickCandidate()
    }
    expect(seen).toEqual(['a_v', 'a_e', 'a_f', 'a_v'])
  })

  it('cycling keeps the rest of the set for re-cycle', () => {
    getState().setPickFromHits(CORNER_HITS)
    getState().cyclePickCandidate()
    expect(getState().pickCandidates).toHaveLength(3)
  })

  it('the entity scope narrows a corner hit to the hovered entity only', () => {
    getState().setPickScopeEntity(EDGE)
    getState().setPickFromHits(CORNER_HITS)
    expect(getState().pickCandidates).toEqual([{ part: PART, anchor: 'a_e' }])
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_e' })
  })

  it('a hit on an anchor-less entity commits nothing', () => {
    getState().setPickFromHits([{ entityKey: FREEFORM }])
    expect(getState().pickCandidates).toEqual([])
    expect(getState().pickIndex).toBe(-1)
    expect(getState().activePickCandidate()).toBeNull()
  })

  it('cycling an empty set stays empty rather than aiming at nothing', () => {
    getState().setPickFromHits([{ entityKey: FREEFORM }])
    getState().cyclePickCandidate()
    expect(getState().pickIndex).toBe(-1)
    expect(getState().activePickCandidate()).toBeNull()
  })

  it('a non-corner hit yields the single candidate a legacy pick would have', () => {
    getState().setPickFromHits([{ entityKey: FACE }])
    expect(getState().pickCandidates).toEqual([{ part: PART, anchor: 'a_f' }])
    getState().cyclePickCandidate()
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_f' })
  })

  it('a re-solve drops the set, so no aim survives into a rebuilt bundle', () => {
    getState().setPickFromHits(CORNER_HITS)
    getState().setSolveResult({}, {}, {}, ENTITY_MATE_REFS)
    expect(getState().pickCandidates).toEqual([])
    expect(getState().activePickCandidate()).toBeNull()
  })

  it('setSnapshot leaves the pick state alone (it is store-owned, not document state)', () => {
    getState().setPickFromHits(CORNER_HITS)
    getState().cyclePickCandidate()
    getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, entityMateRefs: ENTITY_MATE_REFS })
    expect(getState().pickIndex).toBe(1)
    expect(getState().pickCandidates).toHaveLength(3)
  })

  it('clearing empties the set and the aim', () => {
    getState().setPickFromHits(CORNER_HITS)
    getState().clearPickCandidates()
    expect(getState().pickCandidates).toEqual([])
    expect(getState().pickIndex).toBe(-1)
  })
})
