// Stage 7 in the store: a pick keeps its whole candidate set and aims one of
// them. Ctrl+click cycles the aim; Ctrl+hover narrows the set to one entity.
// No viewport, no ID buffer: the hits are synthetic.

import { describe, it, expect, beforeEach } from 'vitest'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import type { AssemblySolveResult } from '@/stores/assemblyStore'
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

const SOLVE_RESULT: AssemblySolveResult = {
  transforms: {}, bodies: {}, edgeCurves: {}, entityMateRefs: ENTITY_MATE_REFS, anchors: {}, pickGeometry: [],
}

/** Resolver order at a corner: vertex wins, then the edge, then the face. */
const CORNER_HITS = [{ entityKey: VERT }, { entityKey: EDGE }, { entityKey: FACE }]

const { getState } = useAssemblyStore

beforeEach(() => {
  getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  getState().clearPickCandidates()
  getState().setPickScopeEntity(null)
  getState().setSolveResult(SOLVE_RESULT)
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
    getState().setSolveResult(SOLVE_RESULT)
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

// Stage 7.5: the hover gate. Anchors are drawn only for what the cursor names,
// and Ctrl narrows that to one entity.
describe('assemblyStore hover', () => {
  it('nothing is hovered by default, so nothing is drawn', () => {
    expect(getState().hoverHits).toEqual([])
    expect(getState().pickScopeEntity).toBeNull()
  })

  it('a hover records every entity under the cursor, resolver-ordered', () => {
    getState().setHoverHits(CORNER_HITS, false)
    expect(getState().hoverHits.map(h => h.entityKey)).toEqual([VERT, EDGE, FACE])
    expect(getState().pickScopeEntity).toBeNull()
  })

  it('Ctrl+hover scopes to the winning entity', () => {
    getState().setHoverHits(CORNER_HITS, true)
    expect(getState().pickScopeEntity).toBe(VERT)
  })

  it('re-resolving the same hits does not churn state: a resting pointer must not rebuild the gizmos', () => {
    getState().setHoverHits(CORNER_HITS, false)
    const first = getState().hoverHits
    getState().setHoverHits([...CORNER_HITS], false)
    expect(getState().hoverHits).toBe(first)
  })

  it('the same hits under a changed Ctrl state do update the scope', () => {
    getState().setHoverHits(CORNER_HITS, false)
    getState().setHoverHits(CORNER_HITS, true)
    expect(getState().pickScopeEntity).toBe(VERT)
  })

  it('releasing Ctrl over the same hits widens the scope again', () => {
    getState().setHoverHits(CORNER_HITS, true)
    getState().setHoverHits(CORNER_HITS, false)
    expect(getState().pickScopeEntity).toBeNull()
  })

  it('leaving the viewport drops the hover and its scope', () => {
    getState().setHoverHits(CORNER_HITS, true)
    getState().clearHover()
    expect(getState().hoverHits).toEqual([])
    expect(getState().pickScopeEntity).toBeNull()
  })

  it('a re-solve drops the hover: its entity keys are positional and a rebuild renumbers them', () => {
    getState().setHoverHits(CORNER_HITS, false)
    getState().setSolveResult(SOLVE_RESULT)
    expect(getState().hoverHits).toEqual([])
  })

  it('setSnapshot leaves the hover alone (it is store-owned, not document state)', () => {
    getState().setHoverHits(CORNER_HITS, false)
    getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, entityMateRefs: ENTITY_MATE_REFS })
    expect(getState().hoverHits).toHaveLength(3)
  })
})

describe('assemblyStore pickFromHitsOrCycle', () => {
  it('the first Ctrl+click aims the top candidate', () => {
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_v' })
  })

  it('clicking the same corner again advances the cycle instead of resetting it', () => {
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_e' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_f' })
  })

  it('clicking a different entity re-aims rather than advancing', () => {
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().pickFromHitsOrCycle(CORNER_HITS)  // aim is now the edge
    getState().pickFromHitsOrCycle([{ entityKey: FACE }])
    expect(getState().pickCandidates).toEqual([{ part: PART, anchor: 'a_f' }])
    expect(getState().pickIndex).toBe(0)
  })

  it('clicking an anchor-less entity clears the aim', () => {
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().pickFromHitsOrCycle([{ entityKey: FREEFORM }])
    expect(getState().pickCandidates).toEqual([])
    expect(getState().activePickCandidate()).toBeNull()
  })

  it('honours the Ctrl+hover scope: a scoped corner click aims that entity only', () => {
    getState().setHoverHits([{ entityKey: EDGE }], true)  // Ctrl+hover pins the edge
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(getState().pickCandidates).toEqual([{ part: PART, anchor: 'a_e' }])
  })
})
