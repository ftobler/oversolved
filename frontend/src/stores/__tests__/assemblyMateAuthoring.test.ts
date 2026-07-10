// Stage 8 in the store: an armed mate chip turns the Stage 7 candidate set into
// a written MateRef. No viewport, no ID buffer, no document store: the hits are
// synthetic and the host callbacks are spies.
//
// The load-bearing rule under test is that committing a pick does NOT re-solve.
// A solve drops `pickCandidates` (a rebuilt bundle can retire the aimed anchor),
// so a solve per pick would make the second Ctrl+click on a corner re-aim the
// vertex instead of advancing to the edge behind it. The solve is owed until the
// field closes.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA, setAssemblyCallbacks } from '@/stores/assemblyStore'
import type { AssemblySolveResult } from '@/stores/assemblyStore'
import { assemblyEntityKey, type EntityMateRefs } from '@/utils/anchorCandidates'
import { appendMate, findMate } from '@/utils/assemblyMutations'

const PART = 'h1'
const VERT = assemblyEntityKey(PART, 0, 'vertex', 0)
const EDGE = assemblyEntityKey(PART, 0, 'edge', 0)
const FACE_B = assemblyEntityKey('h2', 0, 'face', 0)
const FREEFORM = assemblyEntityKey(PART, 0, 'face', 9)

const ENTITY_MATE_REFS: EntityMateRefs = {
  [VERT]: [{ part: PART, anchor: 'a_v' }],
  [EDGE]: [{ part: PART, anchor: 'a_e' }],
  [FACE_B]: [{ part: 'h2', anchor: 'b_f' }],
  [FREEFORM]: [],
}

const SOLVE_RESULT: AssemblySolveResult = {
  transforms: {}, bodies: {}, edgeCurves: {}, entityMateRefs: ENTITY_MATE_REFS, anchors: {},
  pickGeometry: [], mateResults: {},
}

/** Resolver order at a corner: the vertex wins, the edge sits behind it. */
const CORNER_HITS = [{ entityKey: VERT }, { entityKey: EDGE }]

const { getState } = useAssemblyStore

const requestSolve = vi.fn()

/** Stands in for the AssemblyEditor: applies the mutation and re-syncs the store. */
function mutateDoc(fn: (doc: AssemblyDoc) => AssemblyDoc): void {
  const next = fn(getState().doc!)
  getState().setSnapshot({ ...getState(), doc: next })
}

function currentMate(id: string) {
  return findMate(getState().doc!, id)!
}

beforeEach(() => {
  vi.clearAllMocks()
  getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  getState().setActiveMateField(null)
  getState().setSelectedMateId(null)
  getState().clearPickCandidates()
  getState().setPickScopeEntity(null)
  getState().setSolveResult(SOLVE_RESULT)
  setAssemblyCallbacks({ mutateDoc, requestSolve })
  const doc = appendMate({ kind: 'assembly', features: [] }, 'fixed', 'm1')
  getState().setSnapshot({ ...getState(), doc })
  vi.clearAllMocks()
})

describe('arming a mate reference slot', () => {
  it('nothing is armed by default, so a pick only aims', () => {
    expect(getState().activeMateField).toBeNull()
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(getState().activePickCandidate()).toEqual({ part: PART, anchor: 'a_v' })
    expect(currentMate('m1').ref_a).toEqual({ part: '', anchor: '' })
  })

  it('an armed slot takes the aimed reference on the next pick', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(currentMate('m1').ref_b).toEqual({ part: '', anchor: '' })
  })

  it('picking does not re-solve, or the candidate set would be dropped mid-cycle', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(requestSolve).not.toHaveBeenCalled()
    expect(getState().pickCandidates).toHaveLength(2)
  })

  it('clicking the same corner again advances the cycle and rewrites the slot', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
  })

  it('a pick on an anchor-less entity writes nothing', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: FREEFORM }])
    expect(currentMate('m1').ref_a).toEqual({ part: '', anchor: '' })
    expect(getState().mateFieldDirty).toBe(false)
  })

  it('picks across parts fill both slots', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().pickFromHitsOrCycle([{ entityKey: FACE_B }])
    const mate = currentMate('m1')
    expect(mate.ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(mate.ref_b).toEqual({ part: 'h2', anchor: 'b_f' })
  })

  it('re-arming the other slot does not settle the owed solve yet', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    expect(requestSolve).not.toHaveBeenCalled()
    expect(getState().mateFieldDirty).toBe(true)
  })

  it('the Ctrl+hover scope narrows what an armed slot can take', () => {
    getState().setHoverHits([{ entityKey: EDGE }], true)
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
  })

  it('arming ref_b and picking a candidate on the part already in ref_a leaves the document unchanged', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])  // ref_a -> PART
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    const before = getState().doc
    getState().pickFromHitsOrCycle([{ entityKey: EDGE }])  // also on PART: refused
    const mate = currentMate('m1')
    expect(mate.ref_a).toEqual({ part: PART, anchor: 'a_v' })
    expect(mate.ref_b).toEqual({ part: '', anchor: '' })
    expect(getState().doc).toBe(before)
  })
})

describe('closing a mate field', () => {
  it('disarming after a pick asks for exactly one solve', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().setActiveMateField(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
    expect(getState().mateFieldDirty).toBe(false)
  })

  it('disarming without a pick asks for no solve', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().setActiveMateField(null)
    expect(requestSolve).not.toHaveBeenCalled()
  })

  it('disarming twice does not solve twice', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().setActiveMateField(null)
    getState().setActiveMateField(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('leaving the mate settles the solve its picks owe', () => {
    getState().setSelectedMateId('m1')
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().setSelectedMateId(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
    expect(getState().activeMateField).toBeNull()
  })

  it('selecting another mate disarms the previous one', () => {
    getState().setSelectedMateId('m1')
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().setSelectedMateId('m2')
    expect(getState().activeMateField).toBeNull()
    expect(getState().selectedMateId).toBe('m2')
  })
})

// A parameter edit is a document change like a pick, and it has to take the same
// deferral. Solving mid-authoring drops `pickCandidates`, and the still-armed
// field could no longer cycle the corner it aims at.
describe('requestSolveOrDefer', () => {
  it('solves straight away when no chip is armed', () => {
    getState().requestSolveOrDefer()
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('defers while a chip is armed, and the disarm settles it once', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().requestSolveOrDefer()
    expect(requestSolve).not.toHaveBeenCalled()
    expect(getState().mateFieldDirty).toBe(true)

    getState().setActiveMateField(null)
    expect(requestSolve).toHaveBeenCalledTimes(1)
  })

  it('a deferred edit does not disturb the candidate set the armed field cycles', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle(CORNER_HITS)
    getState().requestSolveOrDefer()
    expect(getState().pickCandidates).toHaveLength(2)
    getState().pickFromHitsOrCycle(CORNER_HITS)
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_e' })
  })
})

describe('mate results', () => {
  it('a solve publishes the per-mate stale flags', () => {
    getState().setSolveResult({
      ...SOLVE_RESULT,
      mateResults: { m1: { stale: true, staleRefs: ['ref_b'] } },
    })
    expect(getState().mateResults.m1.stale).toBe(true)
    expect(getState().mateResults.m1.staleRefs).toEqual(['ref_b'])
  })

  // The mate and its dead reference are retained: fail-safe over fail-wrong. The
  // solve never rewrites a ref, so the red row still names what the user picked.
  it('a stale result does not clear the reference it flagged', () => {
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_a' })
    getState().pickFromHitsOrCycle([{ entityKey: VERT }])
    getState().setSolveResult({ ...SOLVE_RESULT, mateResults: { m1: { stale: true, staleRefs: ['ref_a'] } } })
    expect(currentMate('m1').ref_a).toEqual({ part: PART, anchor: 'a_v' })
  })

  it('setSnapshot leaves the authoring state alone (it is store-owned)', () => {
    getState().setSelectedMateId('m1')
    getState().setActiveMateField({ featureId: 'm1', field: 'ref_b' })
    getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, entityMateRefs: ENTITY_MATE_REFS })
    expect(getState().selectedMateId).toBe('m1')
    expect(getState().activeMateField).toEqual({ featureId: 'm1', field: 'ref_b' })
  })
})
